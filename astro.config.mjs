import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

const chapters = [
  ['01. 项目地图与启动', 'chapters/01-architecture-boot'],
  ['02. Cordis 插件内核', 'chapters/02-cordis-plugin-kernel'],
  ['03. Agent 主循环', 'chapters/03-agent-loop'],
  ['04. Session 事件账本', 'chapters/04-session-ledger'],
  ['05. LLM 流式适配', 'chapters/05-llm-streaming'],
  ['06. 工具执行管线', 'chapters/06-tool-pipeline'],
  ['07. Prompt 与上下文', 'chapters/07-prompt-context'],
  ['08. 持久化与恢复', 'chapters/08-persistence-recovery'],
  ['09. Skills 与 Subagents', 'chapters/09-skills-subagents'],
  ['10. CLI、Profile 与无头运行', 'chapters/10-cli-profiles'],
  ['11. Web / TUI 产品界面', 'chapters/11-product-surfaces'],
  ['12. 扩展、测试与实战', 'chapters/12-extension-testing'],
];

export default defineConfig({
  site: 'https://deepseek-harness-study.korah-group.top',
  output: 'static',
  integrations: [
    starlight({
      title: 'DeepSeek Harness 源码学习',
      description: '基于固定源码提交、面向 Java 开发者的 DeepSeek Harness 中文源码课程。',
      locales: { root: { label: '简体中文', lang: 'zh-CN' } },
      social: [
        { icon: 'github', label: '上游源码', href: 'https://github.com/deepseek-ai/deepseek-harness/tree/47f943859bef60e4160492346772ded9b24f765a' },
        { icon: 'open-book', label: 'OpenCode 源码学习', href: 'https://opencode-study.korah-group.top' },
      ],
      sidebar: [
        { label: '学习入口', items: [
          { label: '课程首页', slug: '' },
          { label: '阅读说明与证据', slug: 'reading-guide' },
          { label: 'OpenCode 对照学习 ↗', link: 'https://opencode-study.korah-group.top' },
        ] },
        { label: '完整课程', items: chapters.map(([label, slug]) => ({ label, slug })) },
        { label: '附录', items: [
          { label: '源码索引', slug: 'appendix/source-index' },
          { label: '术语表', slug: 'appendix/glossary' },
        ] },
      ],
      customCss: ['./src/styles/custom.css'],
      pagefind: true,
      lastUpdated: true,
      editLink: { baseUrl: 'https://github.com/Livingpond/deepseek-harness-study-site/edit/main/' },
      credits: true,
      head: [
        { tag: 'meta', attrs: { property: 'og:image', content: 'https://deepseek-harness-study.korah-group.top/og.png' } },
        { tag: 'meta', attrs: { name: 'twitter:card', content: 'summary_large_image' } },
      ],
    }),
  ],
});
