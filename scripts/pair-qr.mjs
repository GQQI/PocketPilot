// 读取 host.log 中最新配对码/链接，输出并生成二维码 PNG
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import QRCode from 'qrcode';
const log = fs.readFileSync('host.log', 'utf8');
const codes = [...log.matchAll(/pairing code (\S+)/g)];
const links = [...log.matchAll(/(https?:\/\/\S+#pair=\S+)/g)];
if (!links.length) { console.error('host.log 中没有配对链接'); process.exit(1); }
const code = codes.length ? codes.at(-1)[1] : '(未知)';
const link = links.at(-1)[1];
const out = process.argv[2] || path.join(os.homedir(), 'pair-qr.png');
await QRCode.toFile(out, link, { width: 600, margin: 2 });
console.log('配对码: ' + code);
console.log('链接: ' + link);
console.log('二维码: ' + out);
