/**
 * Nginx 配置错误解析与中文化诊断工具
 */

export interface ParsedNginxError {
  /** 是否识别为 Nginx 配置相关错误 */
  isNginxError: boolean;
  /** 配置文件错误发生的行号（若能解析出来） */
  line: number | null;
  /** 涉及的配置文件路径（若能解析出来） */
  configFile: string | null;
  /** 简明标题，如“路由规则重复”、“指令缺少分号” */
  title: string;
  /** 友好中文错误原因说明 */
  reason: string;
  /** 具体的修改建议 */
  suggestion: string;
  /** 核心错误短语（提炼后的，非全命令行冗余） */
  coreMessage: string;
  /** 原始完整错误信息 */
  rawError: string;
}

/**
 * 清理路径中的连续重复斜杠（例如 /home/nginx//conf/nginx.conf -> /home/nginx/conf/nginx.conf）
 */
function cleanPath(path: string): string {
  return path.replace(/\/{2,}/g, '/');
}

/**
 * 解析 Nginx 命令/校验产生的错误信息，转换为易读的结构化中文诊断对象。
 * @param rawError 原始错误文本或 Error 对象
 * @returns 结构化诊断结果
 */
export function parseNginxError(rawError: unknown): ParsedNginxError {
  const errorText =
    typeof rawError === 'string'
      ? rawError
      : (rawError as any)?.response?.data?.error ||
        (rawError as any)?.response?.data?.message ||
        (rawError as any)?.message ||
        String(rawError || '');

  // 1. 尝试提取行号与文件路径
  // 典型格式：in /home/nginx//conf/nginx.conf:111 或 in /etc/nginx/nginx.conf line 25
  let line: number | null = null;
  let configFile: string | null = null;

  const fileLineMatch =
    errorText.match(/in\s+([\w./-]+):(\d+)/) ||
    errorText.match(/in\s+([\w./-]+)\s+line\s+(\d+)/i);

  if (fileLineMatch) {
    configFile = cleanPath(fileLineMatch[1]);
    line = parseInt(fileLineMatch[2], 10);
  }

  // 2. 尝试提取核心报错日志级别内容（如 [emerg] ... in ... 或 [emerg] ...）
  let coreMessage = '';
  const emergMatch = errorText.match(/\[(emerg|crit|alert|error)\]\s*(.*?)(?:\s+in\s+[\w./-]+(?::\d+|\s+line\s+\d+)|\s+nginx:|\s*$)/is);
  if (emergMatch) {
    coreMessage = emergMatch[2].trim().replace(/[\r\n]+/g, ' ');
  } else {
    // 若没有匹配到 [emerg]，去除常见的命令外壳前缀与后缀
    coreMessage = errorText
      .replace(/.*?nginx\s+-t[^\n]*?(?:退出码\s*\d+|failed)[^\n]*?\n?/i, '')
      .replace(/nginx:\s*configuration file.*?failed/gi, '')
      .trim();
  }

  // 3. 常见 Nginx 配置错误模式匹配与建议映射
  let title = 'Nginx 校验未通过';
  let reason = coreMessage || 'Nginx 配置文件存在语法或指令错误';
  let suggestion = '请检查配置文件语法后重试。';
  let isNginx = errorText.includes('nginx') || Boolean(line);

  // 规则 1：重复路由规则 duplicate location
  const duplicateMatch = coreMessage.match(/duplicate location\s*("[^"]+"|[^\s]+)/i);
  if (duplicateMatch) {
    const loc = duplicateMatch[1];
    title = '路由规则重复声明';
    reason = `路由路径 ${loc} 被多次重复定义`;
    suggestion = `当前配置文件中已存在同名的 location 块，请检查并删除或修改重复的规则。`;
  }
  // 规则 2：缺少分号 directive "xxx" is not terminated by ";"
  else if (/is not terminated by ";"/i.test(coreMessage)) {
    const directiveMatch = coreMessage.match(/directive\s*("[^"]+"|[^\s]+)/i);
    const directive = directiveMatch ? directiveMatch[1] : '该';
    title = '指令缺少分号';
    reason = `指令 ${directive} 结尾缺少分号 ";"`;
    suggestion = line
      ? `请在第 ${line} 行指令末尾补齐英文半角分号 ";"。`
      : '请在对应指令末尾补齐英文半角分号 ";"。';
  }
  // 规则 3：未知指令 / 拼写错误 unknown directive "xxx"
  else if (/unknown directive\s*("[^"]+"|[^\s]+)/i.test(coreMessage)) {
    const unknownMatch = coreMessage.match(/unknown directive\s*("[^"]+"|[^\s]+)/i);
    const directive = unknownMatch ? unknownMatch[1] : '';
    title = '无法识别的指令';
    reason = `未知配置指令 ${directive}`;
    suggestion = `请检查指令单词拼写是否正确（如 proxy_pass），或确认目标 Nginx 环境是否支持该模块指令。`;
  }
  // 规则 4：多余闭合大括号 unexpected "}"
  else if (/unexpected\s*"}"/i.test(coreMessage)) {
    title = '括号不匹配（多余的 "}"）';
    reason = '检测到多余或意外闭合的花括号 "}"';
    suggestion = '请检查上下文中的大括号 "{}" 是否成对闭合，排查是否有冗余的 "}" 或上一配置块是否过早闭合。';
  }
  // 规则 5：配置块未闭合 unexpected end of file / expecting "}"
  else if (/expecting\s*"}"/i.test(coreMessage) || /unexpected end of file/i.test(coreMessage)) {
    title = '配置块未闭合（缺少 "}"）';
    reason = '文件意外结束，存在未闭合的配置块';
    suggestion = '请检查所有 server 或 location 块，在末尾补充缺失的 "}" 闭合花括号。';
  }
  // 规则 6：指令放置位置不对 "xxx" directive is not allowed here
  else if (/directive is not allowed here/i.test(coreMessage)) {
    const notAllowedMatch = coreMessage.match(/("[^"]+"|[^\s]+)\s*directive is not allowed here/i);
    const directive = notAllowedMatch ? notAllowedMatch[1] : '该';
    title = '指令上下文层级错误';
    reason = `指令 ${directive} 不能放置在此处`;
    suggestion = `该指令仅能在特定上下文块（如 location 块内部）中使用，不能直接放在当前层级，请调整位置。`;
  }
  // 规则 7：指令参数个数错误 invalid number of arguments
  else if (/invalid number of (?:arguments|parameters)/i.test(coreMessage)) {
    const argMatch = coreMessage.match(/in\s*("[^"]+"|[^\s]+)\s*directive/i);
    const directive = argMatch ? argMatch[1] : '';
    title = '指令参数个数不正确';
    reason = directive ? `指令 ${directive} 的参数数量不正确` : '指令参数数量不正确';
    suggestion = '请核对该指令规范要求的参数格式与数量（是否遗漏必填参数或多了多余参数）。';
  }
  // 规则 8：端口已被占用 bind() to ... failed (Address already in use)
  else if (/Address already in use/i.test(coreMessage) || /bind\(\).*failed/i.test(coreMessage)) {
    const portMatch = coreMessage.match(/bind\(\)\s*to\s*([^\s]+)\s*failed/i);
    const addr = portMatch ? portMatch[1] : '目标端口';
    title = '监听端口已被占用';
    reason = `地址 ${addr} 绑定失败，端口已被系统中的其他服务占用`;
    suggestion = '请修改 listen 监听端口，或排查服务器上占用该端口的其他进程。';
  }
  // 规则 9：文件或 SSL 证书不存在 cannot load certificate / No such file or directory
  else if (/No such file or directory/i.test(coreMessage)) {
    const pathMatch = coreMessage.match(/(?:cannot load certificate|open\(\)|BIO_new_file\(\))\s*("[^"]+"|[^\s,:]+)/i);
    const targetFile = pathMatch ? pathMatch[1] : '';
    title = '引用的文件或证书不存在';
    reason = targetFile ? `无法打开文件或证书 ${targetFile}` : '引用的文件或证书不存在';
    suggestion = '请检查配置中引用的外部文件/证书路径是否存在且正确，并确认目标服务器上具备读取权限。';
  }
  // 规则 10：兜底带行号的 emerg 错误
  else if (line) {
    title = `第 ${line} 行语法校验未通过`;
    reason = coreMessage || `第 ${line} 行配置格式有误`;
    suggestion = `请重点检查第 ${line} 行及其前后邻近代码的语法、指令拼写与分号闭合。`;
  }

  // 如果解析到了行号且标题不包含行号，标题前置行号
  const displayTitle = line && !title.includes('第') ? `第 ${line} 行：${title}` : title;

  return {
    isNginxError: isNginx,
    line,
    configFile,
    title: displayTitle,
    reason,
    suggestion,
    coreMessage,
    rawError: errorText,
  };
}

/**
 * 格式化为用于全局简洁弹窗（message.error）的一句话错误摘要。
 * @param parsed 诊断结果
 * @returns 简洁错误提示字符串
 */
export function formatShortNginxErrorMessage(parsed: ParsedNginxError): string {
  if (parsed.line) {
    return `Nginx 校验未通过（第 ${parsed.line} 行）：${parsed.reason}`;
  }
  return `Nginx 校验未通过：${parsed.reason}`;
}
