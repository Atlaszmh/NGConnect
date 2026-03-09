/**
 * Windows Service installer/uninstaller for NGConnect
 *
 * Usage:
 *   npx tsx src/service.ts install    - Install as Windows service
 *   npx tsx src/service.ts uninstall  - Remove Windows service
 */
import path from 'path';

// node-windows doesn't have types, use require
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { Service } = require('node-windows');

const scriptPath = path.join(__dirname, '../dist/index.js');
const envFilePath = path.join(__dirname, '../../.env');

const svc = new Service({
  name: 'NGConnect',
  description: 'NGConnect Media Server Dashboard',
  script: scriptPath,
  nodeOptions: [`--env-file=${envFilePath}`],
  env: [
    { name: 'NODE_ENV', value: 'production' },
  ],
});

const command = process.argv[2];

if (command === 'install') {
  svc.on('install', () => {
    console.log('NGConnect service installed successfully');
    svc.start();
    console.log('Service started');
  });

  svc.on('alreadyinstalled', () => {
    console.log('NGConnect service is already installed');
  });

  svc.on('error', (err: Error) => {
    console.error('Service error:', err);
  });

  svc.install();
} else if (command === 'uninstall') {
  svc.on('uninstall', () => {
    console.log('NGConnect service uninstalled successfully');
  });

  svc.uninstall();
} else {
  console.log('Usage: npx tsx src/service.ts [install|uninstall]');
  console.log('');
  console.log('Commands:');
  console.log('  install    Install NGConnect as a Windows service');
  console.log('  uninstall  Remove the NGConnect Windows service');
}
