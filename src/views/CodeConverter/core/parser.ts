import { LIBRARY_MAP } from './maps';
import { parse as parseSfc } from '@vue/compiler-sfc';
import { parse as parseDom, NodeTypes } from '@vue/compiler-dom';
import { parse as parseBabel } from '@babel/parser';
import generate from '@babel/generator';
import traverse from '@babel/traverse';
import * as t from '@babel/types';

// 默认是 ESM 导出，但 babel 有时需要兼容 CJS
const traverseFn = (traverse as any).default || traverse;
const generateFn = (generate as any).default || generate;

export interface ConversionResult {
  html: string;
  script: string;
  style: string;
  deps?: string[]; // 依赖列表
}

export interface ParsedModule {
  script: string;
  deps: string[];
}

// 增强版驼峰转中划线 (支持 YSplitPane -> y-split-pane)
const camelToKebab = (str: string): string => {
  return str
    .replace(/([a-z])([A-Z])/g, '$1-$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
    .toLowerCase();
};

// HTML void tags (不应该闭合的标签)
const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);

export class VueParser {
  private source: string;

  constructor(source: string) {
    this.source = source;
  }

  public convert(mode: 'page' | 'component', componentName?: string): ConversionResult {
    const { template: rawTemplate, script: rawScript, styles: style } = this.extractSfcBlocks(this.source);
    const html = this.transformTemplate(rawTemplate);
    let script = '';
    let deps: string[] = [];

    if (mode === 'page') {
      const res = this.buildPageScript(html, rawScript);
      script = res.script;
      deps = res.deps;
    } else {
      const res = this.buildComponentScript(html, rawScript, componentName || 'UnknownComponent');
      script = res.script;
      deps = res.deps;
    }

    return { html, script, style: this.transformStyle(style), deps };
  }

  /**
   * 转换普通 TS/JS 模块 (utils, api, constants)
   * 只有 module 模式才将 export 转换为 window 赋值
   */
  public transformModule(moduleName: string): ParsedModule {
    return this.processScript(this.source, {
      isModule: true,
      moduleName,
    });
  }

  // 内部核心：处理脚本
  private processScript(
    code: string,
    options: {
      isModule?: boolean;
      moduleName?: string;
      extractSetup?: boolean; // 是否提取 setup 内部变量 return
    } = {}
  ): { script: string; deps: string[]; returnVars?: string } {
    if (!code.trim()) return { script: '', deps: [] };

    const deps: string[] = [];
    const definedVars = new Set<string>(); // 顶层定义变量

    let ast;
    try {
      ast = parseBabel(code, {
        sourceType: 'module',
        plugins: ['typescript'],
      });
    } catch (e) {
      console.warn('Babel 转换 TS 失败，降级回正则替换:', e);
      // 降级正则
      return {
        script: code
          .replace(/(interface|type)\s+\w+(\s*<[^>]*>)?\s*{[\s\S]*?}/g, '')
          .replace(/type\s+\w+\s*=\s*[^;]+;/g, '')
          .replace(/<[A-Z][a-zA-Z0-9]*(\[\])?>/g, '')
          .replace(/\sas\s+[A-Z][a-zA-Z0-9]*/g, '')
          .replace(/:\s*[A-Z][a-zA-Z0-9<>\[\]|&]*/g, '')
          .replace(/(const|let|var)\s+\w+\s*=\s*(defineProps|defineEmits|withDefaults)\([\s\S]*?\);?/g, '') // remove const props = defineProps(...)
          .replace(/(defineProps|defineEmits|defineOptions)\([\s\S]*?\);?/g, ''), // remove standalone calls
        deps: [],
      };
    }

    traverseFn(ast, {
      // 1. 移除 TS 类型 & Vue Macros
      TSInterfaceDeclaration(path: any) {
        path.remove();
      },
      TSTypeAliasDeclaration(path: any) {
        path.remove();
      },
      TSEnumDeclaration(path: any) {
        path.remove();
      },
      TSTypeParameterDeclaration(path: any) {
        path.remove();
      },
      TSTypeParameterInstantiation(path: any) {
        path.remove();
      },
      TSTypeAnnotation(path: any) {
        path.remove();
      },
      TSAsExpression(path: any) {
        path.replaceWith(path.node.expression);
      },

      // 移除/转换 Vue Macros
      CallExpression(path: any) {
        if (!t.isIdentifier(path.node.callee)) return;
        const name = path.node.callee.name;

        // 移除 defineOptions / defineExpose (runtime cleanup)
        // defineExpose in script setup is just valid, but we might want to ensure it doesn't break?
        // Actually, defineExpose is macro, we can keep it if we ensure compiler handles it,
        // BUT we are manually compiling setup().
        // defineExpose({...}) -> expose({...}) (param of setup)
        // For simplicity, we remove defineOptions.
        if (name === 'defineOptions') {
          path.remove();
        }

        // defineProps / defineEmits / withDefaults
        // const props = defineProps(...) -> remove defineProps logic?
        // In our manual setup() wrap:
        // setup(props, { emit }) already has props/emit.
        // So `const props = defineProps(...)` is redundant if we access `props` directly.
        // But user code uses `props.foo`.
        // If we remove it: `const props = defineProps` -> `params` are props.
        // Transform: `const props = defineProps(...)` -> `// props defined in setup arg`
        // But wait, `props` variable name might be different.
        // And withDefaults?

        // Strategy:
        // 1. Remove call but keep variable decl? No, `props` comes from setup arg.
        // 2. We can't easily map arbitrary var name to setup props arg without scope analysis.
        // HACK: Assume user uses `props`. If `const x = defineProps`, replace with `const x = props;`
        if (['defineProps', 'withDefaults', 'defineEmits'].includes(name) && options.extractSetup) {
          // Handle VariableDeclarator
          if (path.parentPath.isVariableDeclarator()) {
            // const x = defineProps(...)
            const varName = path.parentPath.node.id.name;
            if (name === 'defineEmits') {
              // const emit = defineEmits() -> const emit = emit (local var shadowing setup arg?)
              // Actually setup(props, { emit: emitArg })
              // we can just remove `const emit = defineEmits` because we return `emit` from setup
              // provided we named setup arg `emit`.

              // For now, let's Replace with `emit` identifier if name is defineEmits
              // path.replaceWith(t.identifier('emit'));
              // const emit = emit;  (useless but valid?)
              // Better: remove path.

              // Due to complexity, let's start with removing the CALL only, replacing with matching Identifier?
              // props -> props
              // emit -> emit
              if (name === 'defineEmits') {
                path.replaceWith(t.identifier('emit'));
              } else {
                // defineProps / withDefaults -> props
                path.replaceWith(t.identifier('props'));
              }
            }
          } else {
            // standalone defineProps({...})
            path.remove();
          }
        }
      },

      // 2. 处理 Import
      ImportDeclaration(path: any) {
        const source = path.node.source.value;
        deps.push(source);

        const replacements: any[] = [];
        const globalVar = LIBRARY_MAP[source];

        // 命名导入
        const namedSpecs = path.node.specifiers.filter((s: any) => t.isImportSpecifier(s));
        if (namedSpecs.length > 0) {
          const properties = namedSpecs
            .map((s: any) => {
              if (s.importKind === 'type') return null;
              const importedName = t.isStringLiteral(s.imported) ? s.imported.value : s.imported.name;
              return t.objectProperty(t.identifier(importedName), s.local);
            })
            .filter(Boolean);

          if (properties.length > 0) {
            let rhs;
            if (source === 'vue') {
              // vue imports dropped (handled by wrapper)
              path.remove();
              return;
            } else if (globalVar) {
              rhs = t.identifier(`window.${globalVar}`);
            } else {
              rhs = t.identifier('window');
            }

            if (rhs) {
              let init;
              if (globalVar) {
                init = t.logicalExpression('||', t.identifier(`window.${globalVar}`), t.identifier('window'));
              } else {
                init = t.identifier('window');
              }

              const decl = t.variableDeclaration('const', [t.variableDeclarator(t.objectPattern(properties), init)]);
              replacements.push(decl);
            }
          }
        }

        // 默认导入
        const defaultSpec = path.node.specifiers.find((s: any) => t.isImportDefaultSpecifier(s));
        if (defaultSpec) {
          const localName = defaultSpec.local.name;

          if (source !== 'vue') {
            let init;
            if (globalVar) {
              init = t.identifier(`window.${globalVar}`);
            } else {
              const name = source.split('/').pop().split('.')[0];
              const safe = name.replace(/[^a-zA-Z0-9_$]/g, '_');
              init = t.memberExpression(t.identifier('window'), t.stringLiteral(safe), true);
            }

            const decl = t.variableDeclaration('const', [t.variableDeclarator(t.identifier(localName), init)]);
            replacements.push(decl);
          }
        }

        if (replacements.length > 0) {
          path.replaceWithMultiple(replacements);
        } else {
          path.remove();
        }
      },

      // 3. 处理 Export (仅 Module 模式)
      ExportNamedDeclaration(path: any) {
        if (!options.isModule) return;

        if (path.node.declaration) {
          const decl = path.node.declaration;
          path.replaceWith(decl);

          if (decl.type === 'VariableDeclaration') {
            decl.declarations.forEach((d: any) => {
              if (t.isIdentifier(d.id)) {
                const name = d.id.name;
                path.insertAfter(
                  t.expressionStatement(
                    t.assignmentExpression('=', t.memberExpression(t.identifier('window'), t.identifier(name)), t.identifier(name))
                  )
                );
              }
            });
          } else if (decl.type === 'FunctionDeclaration' || decl.type === 'ClassDeclaration') {
            const name = decl.id.name;
            path.insertAfter(
              t.expressionStatement(t.assignmentExpression('=', t.memberExpression(t.identifier('window'), t.identifier(name)), t.identifier(name)))
            );
          }
        }
      },
      ExportDefaultDeclaration(path: any) {
        if (!options.isModule) return;
        const decl = path.node.declaration;
        const assign = t.expressionStatement(
          t.assignmentExpression('=', t.memberExpression(t.identifier('window'), t.stringLiteral(options.moduleName!), true), decl as any)
        );
        path.replaceWith(assign);
      },

      // 4. 收集顶层变量 (for setup return)
      VariableDeclaration(path: any) {
        if (options.extractSetup && path.parent.type === 'Program') {
          path.node.declarations.forEach((d: any) => {
            if (t.isIdentifier(d.id)) definedVars.add(d.id.name);
          });
        }
      },
      FunctionDeclaration(path: any) {
        if (options.extractSetup && path.parent.type === 'Program' && path.node.id) {
          definedVars.add(path.node.id.name);
        }
      },
    });

    const output = generateFn(ast, {}, code);

    let returnVars = '';
    if (options.extractSetup) {
      returnVars = Array.from(definedVars).join(',\n');
    }

    return {
      script: output.code,
      deps,
      returnVars,
    };
  }

  // --- Helpers ---
  private extractSfcBlocks(source: string): { template: string; script: string; styles: string } {
    const { descriptor } = parseSfc(source, { filename: 'Component.vue' });
    const template = descriptor.template?.content || '';
    const script = (descriptor.scriptSetup && descriptor.scriptSetup.content) || (descriptor.script && descriptor.script.content) || '';
    const styles = (descriptor.styles || []).map((s: any) => s.content || '').join('\n');
    return { template, script, styles };
  }

  private transformTemplate(template: string): string {
    if (!template.trim()) return '';
    const ast = parseDom(template);
    return this.serializeNode(ast, 0);
  }

  private serializeNode(node: any, depth: number): string {
    if (!node) return '';
    const indent = '  '.repeat(depth);
    switch (node.type) {
      case NodeTypes.ROOT:
        return (node.children || []).map((c: any) => this.serializeNode(c, depth)).join('');
      case NodeTypes.ELEMENT:
        const originalTag = node.tag;
        const kebabTag = camelToKebab(originalTag);
        const props = (node.props || []).map((prop: any) => this.serializeProp(prop)).join(' ');
        const children = node.children || [];
        const hasChildren = children.length > 0;
        if (VOID_TAGS.has(kebabTag.toLowerCase())) {
          return `\n${indent}<${kebabTag}${props ? ' ' + props : ''} />`;
        }
        if (!hasChildren) {
          return `\n${indent}<${kebabTag}${props ? ' ' + props : ''}></${kebabTag}>`;
        }
        const childrenHtml = children.map((c: any) => this.serializeNode(c, depth + 1)).join('');
        return `\n${indent}<${kebabTag}${props ? ' ' + props : ''}>${childrenHtml}\n${indent}</${kebabTag}>`;
      case NodeTypes.TEXT:
        const text = node.content;
        if (!text.trim()) return '';
        return text;
      case NodeTypes.COMMENT:
        return `\n${indent}<!--${node.content}-->`;
      case NodeTypes.INTERPOLATION:
        return `{{ ${node.content.content} }}`;
      case NodeTypes.SIMPLE_EXPRESSION:
        return node.content;
      default:
        return '';
    }
  }

  private serializeProp(prop: any): string {
    if (prop.type === NodeTypes.ATTRIBUTE) {
      const name = camelToKebab(prop.name);
      return prop.value ? `${name}="${prop.value.content}"` : name;
    }
    if (prop.type === NodeTypes.DIRECTIVE) {
      const name = prop.name;
      let arg = '';
      if (prop.arg && prop.arg.type === NodeTypes.SIMPLE_EXPRESSION) {
        arg = `:${camelToKebab(prop.arg.content)}`;
      }
      const exp = prop.exp ? `="${prop.exp.content}"` : '';
      if (name === 'bind' && arg) return `${arg}${exp}`;
      if (name === 'on' && arg) return `@${arg.substring(1)}${exp}`;
      if (name === 'slot' && arg) return `#${arg.substring(1)}${exp}`;
      return `v-${name}${arg}${exp}`;
    }
    return '';
  }

  private transformStyle(style: string): string {
    return style.replace(/scoped/g, '').trim();
  }

  // --- Script Builders ---

  private buildPageScript(transformedHtml: string, rawScript: string): { script: string; deps: string[] } {
    const { script: body, deps, returnVars } = this.processScript(rawScript, { extractSetup: true });

    // 移除潜在的 defineProps/Emits 调用 (防止 processScript 遗漏)
    // 已经在 transform 中做了更好的处理，这里可能不需要正则了，但为了保险保留 clean

    const vueDestructure = `const { createApp, ref, reactive, computed, watch, onMounted, nextTick } = Vue;`;
    const tpl = this.escapeTemplate(transformedHtml);

    const final = `(function() {
  ${vueDestructure}
  
  // 注册全局组件
  const registeredComponents = {};
  const camelToKebab = (str) => str.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
  for (const key in window) {
    if (window[key] && typeof window[key] === 'object' && window[key].name && window[key].template) {
       registeredComponents[window[key].name] = window[key];
       registeredComponents[camelToKebab(window[key].name)] = window[key];
    }
  }

  var mountEl = document.getElementById('app');
  var initialTpl = mountEl ? mountEl.innerHTML : '';
  if (mountEl) mountEl.innerHTML = '';
  
  const app = createApp({
    components: registeredComponents,
    template: initialTpl && initialTpl.trim() ? initialTpl : \`<div>${tpl}</div>\`,
    setup() {
      ${body}
      return {
        ${returnVars}
      };
    }
  });

  [window.antd, window.VXETable, window.YssUI].forEach(p => p && app.use(p));
  app.mount('#app');
})();`;
    return { script: final, deps };
  }

  private buildComponentScript(transformedHtml: string, rawScript: string, componentName: string): { script: string; deps: string[] } {
    const { script: body, deps, returnVars } = this.processScript(rawScript, { extractSetup: true });
    const vueDestructure = `const { ref, reactive, computed, watch, onMounted, nextTick } = Vue;`;
    const safeName = componentName.replace(/[^A-Za-z0-9_$]/g, '_');
    const tpl = this.escapeTemplate(transformedHtml);

    // clean defineEmits remnants if AST transform didn't catch specific syntax
    // (AST transform handles 'VariableDeclarator', but pure 'CallExpression' might remain if logic incomplete)
    // The regex is a safe fallback
    const cleanBody = body.replace(/const\s+emit\s*=\s*defineEmits\([^)]*\);?/g, '');

    // Filter out 'emit' from return
    const cleanReturnVars = (returnVars || '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s && s !== 'emit')
      .join(',\n');

    const final = `(function() {
  ${vueDestructure}
  
  const component = {
    name: '${safeName}',
    template: \`${tpl}\`,
    setup(props, { emit }) {
      ${cleanBody}
      return {
        emit,
        ${cleanReturnVars}
      };
    }
  };
  window['${safeName}'] = component;
})();`;

    return { script: final, deps };
  }

  private escapeTemplate(html: string): string {
    return html.replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
  }
}
