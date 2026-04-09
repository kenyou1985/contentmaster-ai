/** 构造 MeTube /upload-cookies 所需的 multipart/form-data（字段名 cookies） */
export function buildMetubeCookiesMultipart(cookiesText: string): { body: Buffer; contentType: string } {
  const boundary = `----CMMetube${Date.now().toString(36)}`;
  const header =
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="cookies"; filename="cookies.txt"\r\n` +
    `Content-Type: text/plain\r\n\r\n`;
  const footer = `\r\n--${boundary}--\r\n`;
  const body = Buffer.concat([
    Buffer.from(header, 'utf8'),
    Buffer.from(cookiesText, 'utf8'),
    Buffer.from(footer, 'utf8'),
  ]);
  return {
    body,
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}
