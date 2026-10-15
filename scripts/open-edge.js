const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');

const edgeExe = fs.existsSync('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe')
  ? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
  : 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe';

const userDataDir = path.join(process.env.LOCALAPPDATA || 'C:\\Users\\CYBERCITY\\AppData\\Local', 'Microsoft', 'Edge', 'AutomationData');
fs.mkdirSync(userDataDir, { recursive: true });

const args = [
  '--remote-debugging-port=9222',
  `--user-data-dir=${userDataDir}`,
  '--no-first-run',
  '--no-default-browser-check',
  'https://www.threads.com/',
  'https://www.facebook.com/',
  'https://x.com/',
  'https://www.instagram.com/'
];

console.log('Launching Edge from:', edgeExe);
console.log('Automation Profile Dir:', userDataDir);

const child = spawn(edgeExe, args, {
  detached: true,
  stdio: 'ignore'
});
child.unref();

console.log('Edge launched. Waiting for port 9222...');
let attempts = 0;
const check = setInterval(() => {
  attempts++;
  http.get('http://127.0.0.1:9222/json/version', res => {
    if (res.statusCode === 200) {
      clearInterval(check);
      console.log('\n🎉 SUCCESS: Microsoft Edge is running with CDP active at http://127.0.0.1:9222');
      console.log('📌 Open tabs: Threads, Facebook, X, Instagram');
      console.log('👉 Log in to each of your accounts in this Edge window. Your session will be saved in AutomationData.');
      process.exit(0);
    }
  }).on('error', () => {
    if (attempts > 30) {
      clearInterval(check);
      console.error('\n⚠️ Port 9222 did not respond in 15 seconds. Please close any background msedge processes in Task Manager and retry.');
      process.exit(1);
    }
  });
}, 500);
