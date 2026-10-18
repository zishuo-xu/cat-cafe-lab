/**
 * 猫咖头像 · 纯内联 SVG 生成器。
 *
 * 不依赖任何外网图片 / 字体 / CDN：四只猫的品种特征全部用 SVG 路径画出来，
 * 由 app.js 以 `innerHTML` 插入（内容是本地生成的，不含用户输入）。
 *
 * avatar key 与 src/domain/types.ts 的 Cat.avatar 对应：
 *   ragdoll / mainecoon / siamese / golden
 */

const BREEDS = {
  ragdoll: {
    fur: "#F8F0E4",
    furShade: "#EBDFCE",
    point: "#8B7768",
    pointSoft: "#A89business", // placeholder replaced below
    earInner: "#EDC7C0",
    eye: "#7FA8C9",
    muzzle: "#FFFBF3",
    nose: "#C98F86",
    tufts: false,
    stripes: false,
    mask: false,
    blush: 0.55,
  },
  mainecoon: {
    fur: "#B98A5E",
    furShade: "#9C7048",
    point: "#6E4A2E",
    pointSoft: "#8B5F3D",
    earInner: "#DDAFA6",
    eye: "#C99A3E",
    muzzle: "#D9B78C",
    nose: "#7A4A38",
    tufts: true,
    stripes: true,
    mask: false,
    blush: 0.4,
  },
  siamese: {
    fur: "#F4E8D4",
    furShade: "#E5D4B8",
    point: "#57433A",
    pointSoft: "#6D5448",
    earInner: "#C9A49C",
    eye: "#6C9AC0",
    muzzle: "#EFE2CD",
    nose: "#3F2E28",
    tufts: false,
    stripes: false,
    mask: true,
    blush: 0.35,
  },
  golden: {
    fur: "#DEBC80",
    furShade: "#C9A469",
    point: "#A98149",
    pointSoft: "#C49C61",
    earInner: "#E8BCAB",
    eye: "#6F8C57",
    muzzle: "#F5E7CB",
    nose: "#B07D6C",
    tufts: false,
    stripes: true,
    mask: false,
    blush: 0.5,
  },
};

// 修一下上面被键盘吃掉的占位值（保持严格 JSON 风格太啰嗦，这里显式赋值）。
BREEDS.ragdoll.pointSoft = "#A28D7C";

const DEFAULT_BREED = BREEDS.golden;

function escapeAttr(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function safeColor(value, fallback) {
  const color = String(value ?? "").trim();
  return /^#[0-9a-fA-F]{3,8}$/.test(color) ? color : fallback;
}

function eyesOpen(breed, accent) {
  return `
    <g class="cat-eyes cat-eyes--open">
      <ellipse cx="25.5" cy="33.6" rx="3.7" ry="4.3" fill="${breed.eye}" />
      <ellipse cx="38.5" cy="33.6" rx="3.7" ry="4.3" fill="${breed.eye}" />
      <ellipse cx="25.5" cy="34" rx="1.15" ry="2.45" fill="#241C17" />
      <ellipse cx="38.5" cy="34" rx="1.15" ry="2.45" fill="#241C17" />
      <circle cx="24.4" cy="32.2" r="0.95" fill="#FFFDF8" opacity="0.9" />
      <circle cx="37.4" cy="32.2" r="0.95" fill="#FFFDF8" opacity="0.9" />
      <path d="M21.6 30.4 q3.9 -2.7 7.8 0" stroke="${breed.point}" stroke-width="1.5" fill="none" stroke-linecap="round" opacity="0.55" />
      <path d="M34.6 30.4 q3.9 -2.7 7.8 0" stroke="${breed.point}" stroke-width="1.5" fill="none" stroke-linecap="round" opacity="0.55" />
    </g>`;
}

function eyesSleeping(breed) {
  return `
    <g class="cat-eyes cat-eyes--sleep" stroke="${breed.point}" stroke-width="2.1" fill="none" stroke-linecap="round" opacity="0.85">
      <path d="M21.9 33.2 q3.6 3.4 7.2 0" />
      <path d="M34.9 33.2 q3.6 3.4 7.2 0" />
    </g>`;
}

function foreheadStripes(breed) {
  return `
    <g stroke="${breed.point}" stroke-width="2" stroke-linecap="round" fill="none" opacity="0.5">
      <path d="M25.2 21.6 c0.9 2.3 1.2 4.2 1 6.2" />
      <path d="M32 19.9 c0.5 2.6 0.5 4.7 0 6.9" />
      <path d="M38.8 21.6 c-0.9 2.3 -1.2 4.2 -1 6.2" />
      <path d="M14.2 33.4 l-3.6 1.4" />
      <path d="M14.4 37.2 l-3.9 2.1" />
      <path d="M49.8 33.4 l3.6 1.4" />
      <path d="M49.6 37.2 l3.9 2.1" />
    </g>`;
}

function earGroup(breed) {
  const tufts = breed.tufts
    ? `<g stroke="${breed.pointSoft}" stroke-width="2" stroke-linecap="round" fill="none">
         <path d="M13.6 8.2 L9.4 4.4" />
         <path d="M15.2 9.4 L11.4 7" />
       </g>`
    : "";
  return `
    <g class="cat-ears">
      <path d="M14.6 27 C11.9 19.2 11.4 12.6 13.6 7.4 C19.2 9.4 25.7 14 28.8 19.6 Z" fill="${breed.point}" />
      <path d="M17.1 23.4 C15.6 18.2 15.4 14 16.4 10.8 C19.6 12.3 23.1 15.4 24.7 18.4 Z" fill="${breed.earInner}" opacity="0.9" />
      ${tufts}
    </g>`;
}

/**
 * 生成一只猫的头像 SVG 字符串。
 * @param {{name?:string, species?:string, avatar?:string, accent?:string}} cat
 * @param {{size?:number, mood?:'idle'|'sleep'|'typing'}} [options]
 */
export function avatarSvg(cat, options = {}) {
  const size = Number(options.size) > 0 ? Number(options.size) : 44;
  const mood = options.mood === "sleep" || options.mood === "typing" ? options.mood : "idle";
  const breed = BREEDS[cat?.avatar] ?? DEFAULT_BREED;
  const accent = safeColor(cat?.accent, "#D9A066");
  const eyes = mood === "sleep" ? eyesSleeping(breed) : eyesOpen(breed, accent);
  const mask = breed.mask
    ? `<ellipse cx="32" cy="36.2" rx="15.6" ry="15" fill="${breed.point}" opacity="0.62" />`
    : "";
  const shade = breed.mask ? "" : `<path d="M32 15.9 C45 15.9 53 24.3 53 34 C53 34.8 52.9 35.6 52.8 36.4 C50.4 43.6 42.3 44 32 44 C21.7 44 13.6 43.6 11.2 36.4 C11.1 35.6 11 34.8 11 34 C11 24.3 19 15.9 32 15.9 Z" fill="${breed.furShade}" opacity="0.32" />`;
  const stripes = breed.stripes ? foreheadStripes(breed) : "";

  return `<svg class="cat-svg" viewBox="0 0 64 64" width="${size}" height="${size}" aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg">
  <circle cx="32" cy="33" r="30.5" fill="${accent}" opacity="0.13" />
  ${earGroup(breed)}
  <g transform="translate(64 0) scale(-1 1)">${earGroup(breed)}</g>
  <path d="M32 15.4 C45.4 15.4 53.6 24 53.6 34.6 C53.6 46.2 44 53.2 32 53.2 C20 53.2 10.4 46.2 10.4 34.6 C10.4 24 18.6 15.4 32 15.4 Z" fill="${breed.fur}" />
  ${shade}
  ${mask}
  ${stripes}
  <ellipse cx="32" cy="41.6" rx="10.6" ry="7.1" fill="${breed.muzzle}" opacity="0.85" />
  <ellipse cx="20" cy="40.2" rx="3.3" ry="2" fill="#F2C6B4" opacity="${breed.blush}" />
  <ellipse cx="44" cy="40.2" rx="3.3" ry="2" fill="#F2C6B4" opacity="${breed.blush}" />
  ${eyes}
  <path d="M32 38.5 L29.7 41 Q32 42.8 34.3 41 Z" fill="${breed.nose}" stroke="${breed.nose}" stroke-width="0.7" stroke-linejoin="round" />
  <path d="M32 41.5 q-2.4 2.8 -4.8 1.1 M32 41.5 q2.4 2.8 4.8 1.1" stroke="${breed.point}" stroke-width="1.4" fill="none" stroke-linecap="round" opacity="0.75" />
  <g stroke="${breed.point}" stroke-width="1.1" stroke-linecap="round" opacity="0.34" fill="none">
    <path d="M21.6 41.1 L13.6 42.6" />
    <path d="M21.7 43.3 L14.2 45.7" />
    <path d="M42.4 41.1 L50.4 42.6" />
    <path d="M42.3 43.3 L49.8 45.7" />
  </g>
</svg>`;
}

/** 铲屎官头像（居右消息用）。 */
export function userAvatarSvg(size = 40) {
  const px = Number(size) > 0 ? Number(size) : 40;
  return `<svg class="cat-svg" viewBox="0 0 64 64" width="${px}" height="${px}" aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg">
  <circle cx="32" cy="32" r="30.5" fill="#D9A066" opacity="0.18" />
  <path d="M32 34.5 C43.6 34.5 52 41.4 52 51.4 L52 60 L12 60 L12 51.4 C12 41.4 20.4 34.5 32 34.5 Z" fill="#6F4E37" opacity="0.92" />
  <circle cx="32" cy="24.5" r="12.5" fill="#F2C6B4" />
  <path d="M19.6 21.4 C20.8 13.6 26 10.2 32 10.2 C38 10.2 43.2 13.6 44.4 21.4 C44.2 15.4 39.6 10.4 32 10.4 C24.4 10.4 19.8 15.4 19.6 21.4 Z" fill="#3A2E28" opacity="0.85" />
  <circle cx="26.8" cy="24.6" r="1.35" fill="#3A2E28" />
  <circle cx="37.2" cy="24.6" r="1.35" fill="#3A2E28" />
  <path d="M29 29.2 q3 2.4 6 0" stroke="#A5635A" stroke-width="1.6" fill="none" stroke-linecap="round" />
</svg>`;
}

/** 猫爪图标（品牌 / 装饰用，颜色继承 currentColor）。 */
export function pawSvg(size = 18) {
  const px = Number(size) > 0 ? Number(size) : 18;
  return `<svg viewBox="0 0 24 24" width="${px}" height="${px}" aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg">
  <path fill="currentColor" d="M12 12.6c-2.9 0-5.9 2.7-5.9 5.2 0 1.9 1.4 3.1 3.2 3.1 1.1 0 1.9-.5 2.7-.5s1.6.5 2.7.5c1.8 0 3.2-1.2 3.2-3.1 0-2.5-3-5.2-5.9-5.2Z" />
  <ellipse cx="5.9" cy="10.2" rx="2.1" ry="2.7" fill="currentColor" transform="rotate(-18 5.9 10.2)" />
  <ellipse cx="9.9" cy="6.6" rx="2.1" ry="2.8" fill="currentColor" />
  <ellipse cx="14.1" cy="6.6" rx="2.1" ry="2.8" fill="currentColor" />
  <ellipse cx="18.1" cy="10.2" rx="2.1" ry="2.7" fill="currentColor" transform="rotate(18 18.1 10.2)" />
</svg>`;
}

/** 咖啡杯 + 猫爪招牌。 */
export function brandMarkSvg(size = 46) {
  const px = Number(size) > 0 ? Number(size) : 46;
  return `<svg viewBox="0 0 48 48" width="${px}" height="${px}" aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg">
  <path d="M18 12.5 c2.1 -2.5 0 -4.8 0 -6.9 M24 11.2 c2.1 -2.7 0 -5.1 0 -7.3 M30 12.5 c2.1 -2.5 0 -4.8 0 -6.9" stroke="#C98A2E" stroke-width="2" stroke-linecap="round" fill="none" opacity="0.8" />
  <ellipse cx="24" cy="40.6" rx="16.4" ry="3.8" fill="#D9A066" opacity="0.45" />
  <path d="M11.2 19.2 h25.6 v9.6 c0 6.6 -5.7 11.7 -12.8 11.7 s-12.8 -5.1 -12.8 -11.7 Z" fill="#FFFDF8" stroke="#6F4E37" stroke-width="2.2" stroke-linejoin="round" />
  <path d="M37 21.8 c5 0 6.8 3.2 6.8 5.7 0 3.5 -3 5.6 -6.9 5.2" fill="none" stroke="#6F4E37" stroke-width="2.2" stroke-linecap="round" />
  <ellipse cx="24" cy="19.4" rx="12.7" ry="3.4" fill="#F2C6B4" />
  <ellipse cx="24" cy="19.6" rx="11.2" ry="2.6" fill="#6F4E37" />
  <ellipse cx="24" cy="31.4" rx="4.6" ry="3.8" fill="#D9A066" />
  <ellipse cx="19.1" cy="27.1" rx="1.8" ry="2.2" fill="#D9A066" />
  <ellipse cx="22.8" cy="25.7" rx="1.8" ry="2.2" fill="#D9A066" />
  <ellipse cx="26.8" cy="25.7" rx="1.8" ry="2.2" fill="#D9A066" />
  <ellipse cx="30.4" cy="27.1" rx="1.8" ry="2.2" fill="#D9A066" />
</svg>`;
}
