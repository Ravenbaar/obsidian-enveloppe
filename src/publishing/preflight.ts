/** Local, content-safe checks shared by the command and the final upload guard. */
export class PublicationPreflightError extends Error {
  constructor(readonly line: number, readonly reason: string) {
    super(`发布前检查未通过：原稿第 ${line} 行，${reason}`);
    this.name = 'PublicationPreflightError';
  }
}

type Metadata = Record<string, unknown>;
type YamlParser = (text: string) => unknown;
export interface ProtectionInspection {
  encrypted: boolean;
  passwordKey?: string;
  protectedLine: number;
  markers: string[];
}

export function isPublishingArticle(enabled: boolean | undefined, path: string): boolean {
  return enabled === true && /^src\/content\/posts\/.+\.mdx?$/i.test(path)
    && !path.split('/').some(segment => segment === '.' || segment === '..');
}

function sourceParts(source: string, parseYaml: YamlParser) {
  const lines = source.replace(/^\uFEFF/, '').split(/\r?\n/);
  let data: Metadata = {};
  let bodyStart = 0;
  if (lines[0] === '---') {
    const end = lines.findIndex((line, index) => index > 0 && /^---[ \t]*$/.test(line));
    if (end < 0) throw new PublicationPreflightError(1, 'YAML 属性区缺少结束的 ---。');
    try {
      const parsed = parseYaml(lines.slice(1, end).join('\n'));
      if (parsed != null && (typeof parsed !== 'object' || Array.isArray(parsed))) throw new Error();
      data = (parsed || {}) as Metadata;
    } catch {
      // Parser diagnostics may echo a secret from the source. Never display them.
      throw new PublicationPreflightError(1, 'YAML 属性格式无效，请检查缩进、引号和重复属性。');
    }
    bodyStart = end + 1;
  }
  const keyLine = (key: string) => {
    const index = lines.slice(0, bodyStart).findIndex(line => new RegExp(`^(?:${key}|"${key}"|'${key}')[ \\t]*:`).test(line));
    return index < 0 ? 1 : index + 1;
  };
  return { lines, data, bodyStart, keyLine };
}

export function inspectPublicationSource(source: string, parseYaml: YamlParser, path = 'article.md'): ProtectionInspection {
  const { lines, data, bodyStart, keyLine } = sourceParts(source, parseYaml);
  const fail = (line: number, reason: string): never => { throw new PublicationPreflightError(line, reason); };
  for (const key of ['password', 'passphrase']) {
    if (Object.hasOwn(data, key)) fail(keyLine(key), '请删除明文密码属性；正文只填写 passwordKey，密码应保存在网站的加密配置中。');
  }
  if (data.encrypted !== undefined && typeof data.encrypted !== 'boolean') {
    fail(keyLine('encrypted'), 'encrypted 必须填写 true 或 false，不能加引号。');
  }
  if (data.passwordKey !== undefined && (typeof data.passwordKey !== 'string' || !/^[\w-]{1,64}$/.test(data.passwordKey))) {
    fail(keyLine('passwordKey'), 'passwordKey 必须是 1–64 位英文字母、数字、下划线或连字符。');
  }
  const encrypted = data.encrypted === true;
  const passwordKey = data.passwordKey as string | undefined;
  if (encrypted && !passwordKey) fail(keyLine('encrypted'), '整篇加密需要在 YAML 属性区填写 passwordKey。');
  const body = lines.slice(bodyStart).join('\n');
  for (const match of body.matchAll(/<!--\s*(?:\/\s*)?encrypt/gi)) {
    if (/\n/.test(match[0])) fail(bodyStart + body.slice(0, match.index).split('\n').length, '加密标记不能跨行，开始与结束标记都必须各占一行。');
  }
  const markers: string[] = [];
  let opening = 0;
  let firstRegion = 0;
  for (let index = bodyStart; index < lines.length; index++) {
    const line = lines[index];
    if (!/<!--\s*(?:\/\s*)?encrypt/i.test(line)) continue;
    const start = line.match(/^<!-- encrypt(?::([\w-]{1,64}))? -->[ \t]*$/);
    if (start) {
      if (opening) fail(index + 1, '加密区块不能嵌套；请先补齐前一个区块的 <!-- /encrypt -->。');
      if (!encrypted && !passwordKey) fail(index + 1, '局部加密也需要在 YAML 属性区填写 passwordKey，即使开始标记已指定密钥名称。');
      opening = index + 1;
      firstRegion ||= opening;
      markers.push(`open:${start[1] || ''}`);
    } else if (/^<!-- \/encrypt -->[ \t]*$/.test(line)) {
      if (!opening) fail(index + 1, '结束标记没有对应的开始标记 <!-- encrypt -->。');
      markers.push('close');
      opening = 0;
    } else {
      fail(index + 1, '加密标记格式无效。请使用独立、顶格的小写 <!-- encrypt:KEY --> 和 <!-- /encrypt -->；示例请将 < 写成 &lt;。');
    }
  }
  if (opening) fail(opening, '此处开始的加密区块缺少结束标记 <!-- /encrypt -->。');
  if (passwordKey && !encrypted && !firstRegion) fail(keyLine('passwordKey'), 'passwordKey 需要搭配整篇加密或至少一个加密区块。');
  if ((encrypted || firstRegion) && !/\.md$/i.test(path)) fail(firstRegion || keyLine('encrypted'), '加密文章仅支持 .md，不能使用 .mdx。');
  return { encrypted, passwordKey, markers, protectedLine: firstRegion || keyLine('encrypted') };
}

export function assertProtectionPreserved(original: ProtectionInspection, converted: string, parseYaml: YamlParser, path: string): void {
  let next: ProtectionInspection;
  try { next = inspectPublicationSource(converted, parseYaml, path); }
  catch {
    throw new PublicationPreflightError(original.protectedLine, '内容转换后加密格式无效；请检查文本替换、嵌入和属性转换设置，原稿未上传。');
  }
  if (original.encrypted !== next.encrypted || original.passwordKey !== next.passwordKey
    || JSON.stringify(original.markers) !== JSON.stringify(next.markers)) {
    throw new PublicationPreflightError(original.protectedLine, '内容转换改变了加密属性或区块边界；请检查转换设置，原稿未上传。');
  }
}
