/**
 * 交付台头像 · 纯内联 SVG 生成器。
 *
 * 不依赖任何外网图片 / 字体 / CDN：四个角色的图标全部用 SVG 路径画出来，
 * 由 app.js 以 `innerHTML` 插入（内容是本地生成的，不含用户输入）。
 *
 * avatar key 与 src/domain/types.ts 的 Member.avatar 对应：
 *   architect / reviewer / designer / implementer
 */

const STYLES = {
  architect: { bg: "#EAF0F6", fg: "#587A93", accent: "#7C9EB2" },
  reviewer: { bg: "#F3EDE6", fg: "#7A5C42", accent: "#8C6A4F" },
  designer: { bg: "#FBF4DC", fg: "#9A7B14", accent: "#C9A227" },
  implementer: { bg: "#E9F3EA", fg: "#4A7A54", accent: "#5F9A6E" },
};

/** 各角色的图形元素（24×24 坐标系）。 */
const GLYPHS = {
  // 架构师：层级图（三个方块 + 连线）
  architect: `
    <rect x="9" y="2.5" width="6" height="5" rx="1.2" />
    <rect x="2.5" y="16" width="6" height="5" rx="1.2" />
    <rect x="15.5" y="16" width="6" height="5" rx="1.2" />
    <path d="M12 7.5v4M5.5 16v-4.5h13V16" fill="none" stroke-width="1.4"
          stroke-linecap="round" stroke-linejoin="round" />`,
  // 评审：放大镜里一个对勾
  reviewer: `
    <circle cx="10.5" cy="10.5" r="6.2" fill="none" stroke-width="1.6" />
    <path d="M15.2 15.2 L20 20" fill="none" stroke-width="1.9" stroke-linecap="round" />
    <path d="M7.6 10.6l2.1 2.1 3.4-3.6" fill="none" stroke-width="1.6"
          stroke-linecap="round" stroke-linejoin="round" />`,
  // 设计：调色板
  designer: `
    <path d="M12 3c-4.9 0-8.8 3.6-8.8 8.1 0 3.2 2.3 5.2 5 5.2 1.1 0 1.8-.6 1.8-1.5 0-.7-.4-1-.4-1.7 0-.7.6-1.2 1.4-1.2h1.8c2.6 0 4.5-1.9 4.5-4.4C17.3 5.4 15 3 12 3z"
          fill="none" stroke-width="1.5" stroke-linejoin="round" />
    <circle cx="8.2" cy="9.4" r="1.05" stroke="none" />
    <circle cx="11.6" cy="7.2" r="1.05" stroke="none" />
    <circle cx="15" cy="9" r="1.05" stroke="none" />`,
  // 实现：代码括号 + 斜杠
  implementer: `
    <path d="M8.4 7.5 L3.6 12l4.8 4.5" fill="none" stroke-width="1.7"
          stroke-linecap="round" stroke-linejoin="round" />
    <path d="M15.6 7.5 L20.4 12l-4.8 4.5" fill="none" stroke-width="1.7"
          stroke-linecap="round" stroke-linejoin="round" />
    <path d="M13.4 5.2 L10.6 18.8" fill="none" stroke-width="1.5" stroke-linecap="round" />`,
};

/**
 * 生成一个头像的 SVG 字符串。
 * @param {keyof STYLES} kind
 * @param {{ size?: number }} [options]
 */
export function memberAvatar(kind, options = {}) {
  const style = STYLES[kind] ?? STYLES.architect;
  const glyph = GLYPHS[kind] ?? GLYPHS.architect;
  const size = options.size ?? 40;
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none"
    stroke="${style.fg}" stroke-width="1.5" aria-hidden="true" class="member-avatar">
    <rect x="0" y="0" width="24" height="24" rx="7" fill="${style.bg}" stroke="none" />
    <g stroke="${style.fg}">${glyph}</g>
  </svg>`;
}

/** 兼容旧调用点：按角色取头像。 */
export function catAvatar(kind, options = {}) {
  return memberAvatar(kind, options);
}

/** app.js 的主入口：按成员对象取头像。 */
export function avatarSvg(member, options = {}) {
  return memberAvatar(member?.avatar ?? "architect", options);
}

/** 「负责人」（用户）的头像：一个圆角方块里的人形。 */
export function userAvatarSvg(size = 40) {
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none"
    aria-hidden="true" class="member-avatar">
    <rect x="0" y="0" width="24" height="24" rx="7" fill="#EFE7DD" stroke="none" />
    <circle cx="12" cy="9.4" r="3.4" fill="none" stroke="#8A6A52" stroke-width="1.5" />
    <path d="M5.6 19.4c0-3.2 2.9-4.8 6.4-4.8s6.4 1.6 6.4 4.8" fill="none"
      stroke="#8A6A52" stroke-width="1.5" stroke-linecap="round" />
  </svg>`;
}

/** 品牌图标：三块叠放的卡片，代表「协作产物」。 */
export function brandMarkSvg(size = 46) {
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none"
    aria-hidden="true">
    <rect x="0" y="0" width="24" height="24" rx="6" fill="#F6EEE3" stroke="none" />
    <rect x="6.2" y="4.4" width="11.6" height="3.4" rx="1.1" fill="#C9A57B" />
    <rect x="4.8" y="9.4" width="14.4" height="3.4" rx="1.1" fill="#A87A4E" />
    <rect x="6.2" y="14.4" width="11.6" height="3.4" rx="1.1" fill="#7C5A3C" />
  </svg>`;
}

/** 兼容旧名。 */
export function pawSvg(size = 18) {
  return brandMarkSvg(size);
}
