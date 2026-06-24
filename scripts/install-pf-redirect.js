#!/usr/bin/env node
// ⚠️ 已废弃(自 v0.1.11):Haystack 内置 HTTP 服务已改为默认监听高位端口(8765 起),
// 不再绑 80、也不需要 root 权限,本脚本(把 80 透明转到 8080)已无实际用途,保留仅作历史参考。
//
// 把本机 80 端口的 TCP 流量 (lo0 上) 透明转到 127.0.0.1:8080
// 让 Haystack 内置 HTTP 服务（非 root，只能 bind 8080）从外部看像跑在 80 端口
//
// 用法:
//   sudo node install-pf-redirect.js install     # 安装 + 立即生效 + 开机自启
//   sudo node install-pf-redirect.js uninstall   # 卸载
//   sudo node install-pf-redirect.js status      # 查看状态
//
// 改动:
//   /etc/pf.anchors/haystack
//   /etc/pf.conf                          (插入两行 anchor 钩子)
//   /Library/LaunchDaemons/studio.baijing.haystack-pf.plist
//
// 仅 macOS

const fs = require('fs');
const os = require('os');
const { execSync } = require('child_process');

const ANCHOR_NAME = 'haystack';
const ANCHOR_PATH = '/etc/pf.anchors/haystack';
const PF_CONF = '/etc/pf.conf';
const LAUNCH_DAEMON = '/Library/LaunchDaemons/studio.baijing.haystack-pf.plist';
const LABEL = 'studio.baijing.haystack-pf';
const SRC_PORT = 80;
const DST_PORT = 8080;

const ANCHOR_RULE =
  `rdr pass on lo0 inet proto tcp from any to any port ${SRC_PORT} -> 127.0.0.1 port ${DST_PORT}\n`;

const PF_HOOK_BEGIN = '# >>> haystack pf hook >>>';
const PF_HOOK_END = '# <<< haystack pf hook <<<';
const PF_HOOK_BLOCK =
  `${PF_HOOK_BEGIN}\n` +
  `rdr-anchor "${ANCHOR_NAME}"\n` +
  `load anchor "${ANCHOR_NAME}" from "${ANCHOR_PATH}"\n` +
  `${PF_HOOK_END}\n`;

const PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/sbin/pfctl</string>
    <string>-E</string>
    <string>-f</string>
    <string>${PF_CONF}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <false/>
  <key>StandardOutPath</key>
  <string>/var/log/${LABEL}.log</string>
  <key>StandardErrorPath</key>
  <string>/var/log/${LABEL}.log</string>
</dict>
</plist>
`;

function die(msg) {
  console.error('错误: ' + msg);
  process.exit(1);
}

function checkPlatform() {
  if (os.platform() !== 'darwin') die('只支持 macOS');
}

function checkRoot() {
  if (process.getuid && process.getuid() !== 0) {
    die('需要 root 权限,请用 sudo 运行');
  }
}

function readPfConf() {
  return fs.readFileSync(PF_CONF, 'utf8');
}

function writePfConfWithHook() {
  const cur = readPfConf();
  if (cur.includes(PF_HOOK_BEGIN)) return false;
  // 必须插在 translation 段内（即在 anchor "com.apple/*" filter 锚点之前），
  // 否则 pfctl 会报 "Rules must be in order: ... translation, filtering"。
  // 锚定到 rdr-anchor "com.apple/*" 之后插入；找不到则降级追加到末尾。
  const target = /(rdr-anchor\s+"com\.apple\/\*"\s*\n)/;
  let next;
  if (target.test(cur)) {
    next = cur.replace(target, `$1${PF_HOOK_BLOCK}`);
  } else {
    next = cur.trimEnd() + '\n\n' + PF_HOOK_BLOCK;
  }
  fs.writeFileSync(PF_CONF, next);
  return true;
}

function stripHookFromPfConf() {
  const cur = readPfConf();
  const re = new RegExp(
    `\\n?${PF_HOOK_BEGIN}[\\s\\S]*?${PF_HOOK_END}\\n?`,
    'g'
  );
  if (!re.test(cur)) return false;
  fs.writeFileSync(PF_CONF, cur.replace(re, '\n'));
  return true;
}

function applyPf() {
  // -E 引用计数 enable + -f 重新加载主配置（com.apple 锚点不受影响）
  execSync(`pfctl -E -f ${PF_CONF}`, { stdio: 'inherit' });
}

function disablePf() {
  try { execSync('pfctl -X 1', { stdio: 'ignore' }); } catch {}
}

function loadDaemon() {
  try { execSync(`launchctl bootout system ${LAUNCH_DAEMON}`, { stdio: 'ignore' }); } catch {}
  execSync(`launchctl bootstrap system ${LAUNCH_DAEMON}`, { stdio: 'inherit' });
}

function unloadDaemon() {
  try { execSync(`launchctl bootout system ${LAUNCH_DAEMON}`, { stdio: 'ignore' }); } catch {}
}

// 用真实用户身份探测 0.0.0.0:80 的可用性。返回 { code }
//   code = 'OK'         本用户能 bind,Haystack 会直接占 80,pf rdr 反而碍事
//   code = 'INUSE'      已被某个进程占用,装 pf 会抢走人家的流量(Haystack 自身 / nginx 等)
//   code = 'NOPERM'     权限不够 bind <1024,Haystack 也会 fallback 8080,这才是 pf 该上场的场景
//   code = 'UNKNOWN'    其他,谨慎处理
function probePort80AsRealUser() {
  const realUid = process.env.SUDO_UID ? Number(process.env.SUDO_UID) : null;
  const realGid = process.env.SUDO_GID ? Number(process.env.SUDO_GID) : null;
  if (realUid === null || realUid === 0) return { code: 'UNKNOWN', reason: '无 SUDO_UID,无法以真实用户身份探测' };
  const probe = `
    const net = require('net');
    const srv = net.createServer();
    srv.once('error', e => { process.stdout.write(e.code || 'ERR'); process.exit(2); });
    srv.listen(80, '0.0.0.0', () => srv.close(() => { process.stdout.write('OK'); process.exit(0); }));
  `;
  const { spawnSync } = require('child_process');
  const r = spawnSync(process.execPath, ['-e', probe], {
    uid: realUid,
    gid: realGid,
    timeout: 3000,
  });
  if (r.error || r.signal) return { code: 'UNKNOWN', reason: r.error ? r.error.message : 'signal ' + r.signal };
  const out = (r.stdout || '').toString().trim();
  if (r.status === 0 && out === 'OK') return { code: 'OK' };
  if (out === 'EACCES' || out === 'EPERM') return { code: 'NOPERM', reason: out };
  if (out === 'EADDRINUSE') return { code: 'INUSE', reason: out };
  return { code: 'UNKNOWN', reason: out || ('exit=' + r.status) };
}

async function install() {
  const probe = probePort80AsRealUser();
  if (probe.code === 'OK') {
    console.log('检测到当前用户可直接 bind 0.0.0.0:80。');
    console.log('Haystack 启动时会直接占 80,装 pf 反而会把 lo0:80 截到空 8080。');
    console.log('已退出,未做任何改动。');
    return;
  }
  if (probe.code === 'INUSE') {
    console.log('80 端口已被占用(' + (probe.reason || '') + ')。');
    console.log('如果是 Haystack 自己占的,装 pf 会让它收不到 lo0 流量;');
    console.log('如果是别的服务(nginx 等)占的,装 pf 会抢走它的流量。');
    console.log('已退出,未做任何改动。如确需安装,先关掉占用进程再跑。');
    return;
  }
  if (probe.code === 'UNKNOWN') {
    console.log('警告: 无法以真实用户身份探测 80 端口可用性(' + (probe.reason || '') + ')。');
    console.log('如果你确定 Haystack 当前 fallback 在 8080 才需要这个脚本,带 --force 重跑。');
    if (!process.argv.includes('--force')) return;
  }
  // probe.code === 'NOPERM' 或 --force: 正常装

  fs.writeFileSync(ANCHOR_PATH, ANCHOR_RULE, { mode: 0o644 });
  fs.chownSync(ANCHOR_PATH, 0, 0);
  console.log(`✓ 写入 ${ANCHOR_PATH}`);

  const wrote = writePfConfWithHook();
  console.log(wrote ? `✓ 已插入钩子到 ${PF_CONF}` : `· ${PF_CONF} 已有钩子,跳过`);

  fs.writeFileSync(LAUNCH_DAEMON, PLIST, { mode: 0o644 });
  fs.chownSync(LAUNCH_DAEMON, 0, 0);
  console.log(`✓ 写入 ${LAUNCH_DAEMON}`);

  applyPf();
  console.log('✓ pf 规则已立即生效');

  loadDaemon();
  console.log('✓ LaunchDaemon 已注册（开机自启）');

  console.log('\n完成。验证:');
  console.log('  curl -sI http://127.0.0.1/  # 应得到来自 8080 的响应');
  console.log('  pfctl -s nat -a haystack');
}

function uninstall() {
  unloadDaemon();
  console.log('✓ 卸载 LaunchDaemon');

  try { fs.unlinkSync(LAUNCH_DAEMON); console.log(`✓ 移除 ${LAUNCH_DAEMON}`); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }

  const stripped = stripHookFromPfConf();
  console.log(stripped ? `✓ 从 ${PF_CONF} 移除钩子` : `· ${PF_CONF} 没有钩子,跳过`);

  try { fs.unlinkSync(ANCHOR_PATH); console.log(`✓ 移除 ${ANCHOR_PATH}`); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }

  // 重新加载 pf.conf,使更改生效；不强制 disable pf,以免影响其他锚点
  try { execSync(`pfctl -f ${PF_CONF}`, { stdio: 'inherit' }); } catch {}
  console.log('\n完成');
}

function status() {
  const anchorExists = fs.existsSync(ANCHOR_PATH);
  const plistExists = fs.existsSync(LAUNCH_DAEMON);
  const hookPresent = readPfConf().includes(PF_HOOK_BEGIN);
  console.log(`anchor file : ${anchorExists ? ANCHOR_PATH : '(不存在)'}`);
  console.log(`pf.conf hook: ${hookPresent ? '已安装' : '未安装'}`);
  console.log(`LaunchDaemon: ${plistExists ? LAUNCH_DAEMON : '(不存在)'}`);
  try {
    const out = execSync(`pfctl -s nat -a ${ANCHOR_NAME} 2>&1`).toString();
    console.log('\n当前 pf rdr 规则 (anchor=' + ANCHOR_NAME + '):');
    console.log(out.trim() || '(空)');
  } catch (e) {
    console.log('\n查询 pf 失败: ' + e.message);
  }
}

async function main() {
  checkPlatform();
  const cmd = process.argv[2] || 'install';
  if (cmd === 'install') { checkRoot(); await install(); }
  else if (cmd === 'uninstall') { checkRoot(); uninstall(); }
  else if (cmd === 'status') { status(); }
  else die(`未知子命令: ${cmd} (install | uninstall | status)`);
}

main().catch(e => { console.error(e); process.exit(1); });
