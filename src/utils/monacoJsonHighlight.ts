import * as monaco from 'monaco-editor/esm/vs/editor/editor.api';

let configured = false;

/** OpenAPI JSON 专用 Monaco 语言 ID。 */
export const OPENAPI_JSON_LANGUAGE = 'openapi-json';

/** JSON 的 Monarch 语法高亮规则。 */
const jsonSyntax: monaco.languages.IMonarchLanguage = {
  tokenizer: {
    root: [
      [/\s+/, 'white'],
      [/"(?:\\.|[^"\\])*"(?=\s*:)/, 'string.key.json'],
      [/"(?:\\.|[^"\\])*"/, 'string.value.json'],
      [/-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/, 'number.json'],
      [/\b(?:true|false|null)\b/, 'keyword.json'],
      [/[{}\[\]]/, 'delimiter.bracket.json'],
      [/[:,]/, 'delimiter.json'],
    ],
  },
};

/**
 * 注册 JSON 语法高亮兜底。
 * @description Monaco JSON language service 未及时注册 token provider 时，仍保证 key、值、数字和关键字分色。
 */
export const configureMonacoJsonHighlight = (): void => {
  if (configured) return;
  monaco.languages.register({
    id: OPENAPI_JSON_LANGUAGE,
    aliases: ['OpenAPI JSON'],
    mimetypes: ['application/vnd.oai.openapi+json'],
  });
  monaco.languages.setMonarchTokensProvider(OPENAPI_JSON_LANGUAGE, jsonSyntax);
  configured = true;
};
