import tls from 'node:tls';

// nodemailer's transport fails to connect inside workerd, so this is a minimal client:
// implicit TLS (465), AUTH PLAIN, one message per connection.
export interface SmtpOptions {
  host: string;
  port: number;
  user: string;
  pass: string;
  tls?: tls.ConnectionOptions;
}

export async function smtpSend(o: SmtpOptions, from: string, to: string[], raw: Buffer): Promise<void> {
  if (!to.length) throw new Error('No recipients');
  // Addresses go into SMTP command lines: anything that could end or extend a command is refused.
  for (const a of [from, ...to]) if (/[\r\n<>\s]/.test(a)) throw new Error(`Invalid address for SMTP: ${JSON.stringify(a)}`);
  const sock = tls.connect({ host: o.host, port: o.port, ...o.tls });
  sock.setTimeout?.(30_000, () => sock.destroy(new Error('SMTP timeout')));
  let buf = '';
  let err: Error | undefined;
  let wake = () => {};
  sock.on('data', (d: Buffer) => ((buf += d.toString('latin1')), wake()));
  sock.on('error', (e: Error) => ((err = e), wake()));
  sock.on('close', () => ((err ??= new Error('SMTP connection closed')), wake()));

  // Reads one full reply; continuation lines are "250-...", the last one is "250 ...".
  const expect = async (...codes: number[]) => {
    for (;;) {
      const m = /^(\d{3})(?: .*)?\r?\n/m.exec(buf);
      if (m) {
        const text = buf.slice(0, m.index + m[0].length);
        buf = buf.slice(m.index + m[0].length);
        if (!codes.includes(Number(m[1]))) throw new Error(`SMTP ${text.trim()}`);
        return;
      }
      if (err) throw err;
      await new Promise<void>((r) => (wake = r));
    }
  };
  const cmd = (line: string, ...codes: number[]) => (sock.write(line + '\r\n'), expect(...codes));

  try {
    await expect(220);
    await cmd('EHLO nmail-mcp', 250);
    await cmd('AUTH PLAIN ' + Buffer.from(`\0${o.user}\0${o.pass}`).toString('base64'), 235);
    await cmd(`MAIL FROM:<${from}>`, 250);
    for (const r of to) await cmd(`RCPT TO:<${r}>`, 250, 251);
    await cmd('DATA', 354);
    // Dot-stuffing (RFC 5321 4.5.2), then the terminating "."
    const body = raw.toString('latin1').replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..');
    sock.write(body.endsWith('\r\n') ? body : body + '\r\n', 'latin1');
    await cmd('.', 250);
    await cmd('QUIT', 221).catch(() => {});
  } finally {
    sock.destroy();
  }
}
