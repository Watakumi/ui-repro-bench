/**
 * 記事サムネ・書影などの図版。すべて SVG で描く（画像アセットは使わない）。
 * 写真の部分だけ平均色の面で置き、載っている文字・図形は描く。
 */

const OLIVE = '#66620c'
const INK = '#3d3a12'
const MINCHO = "'Hiragino Mincho ProN','Hiragino Mincho Pro',serif"

/** NewsPicks のシマウマ風マーク（斜線の束）。x,y は左上、s は大きさ。 */
export function NpMark({ x, y, s, color = INK }: { x: number; y: number; s: number; color?: string }) {
  const k = s / 20
  return (
    <g transform={`translate(${x} ${y}) scale(${k})`} stroke={color} strokeWidth={2.2} strokeLinecap="round" fill="none">
      <path d="M2 10 9 3" />
      <path d="M4 14 13 5" />
      <path d="M7 17 16 8" />
      <path d="M11 19 18 12" />
      <path d="M12 2 15 0.5" />
    </g>
  )
}

/** 「今週の1冊」の斜めの札（本のマーク付き）。 */
export function WeeklyBadge({ x, y, s, color = INK }: { x: number; y: number; s: number; color?: string }) {
  const k = s / 30
  return (
    <g transform={`translate(${x} ${y}) scale(${k}) rotate(-28 15 15)`} fill={color}>
      <text x="2" y="10" fontSize="8.5" fontWeight="700" fontFamily="'Hiragino Sans',sans-serif">今週の</text>
      <path d="M6 13h18l2 3v11H8l-2-3z" />
      <path d="M8 27h18" stroke="#fff" strokeWidth="0.8" />
      <text x="13" y="24" fontSize="10" fontWeight="800" fill="#fff" fontFamily="'Hiragino Sans',sans-serif">1</text>
      <text x="26" y="24" fontSize="8" fontWeight="700" fontFamily="'Hiragino Sans',sans-serif">冊</text>
    </g>
  )
}

/** 巻物の書影『完全版 経営戦略全史』。viewBox 235x128。 */
export function BookArt({ className, bg = '#f7f03f' }: { className?: string; bg?: string }) {
  const rollHatch = (x0: number) =>
    Array.from({ length: 22 }, (_, i) => (
      <path key={i} d={`M${x0} ${14 + i * 4.8}h13`} stroke={INK} strokeWidth="0.7" />
    ))
  return (
    <svg viewBox="0 0 235 128" preserveAspectRatio="xMidYMid slice" className={className} aria-hidden>
      <rect width="235" height="128" fill={bg} />
      {/* 紙の部分 */}
      <path d="M22 12c30-5 60 3 95-1s65-4 96 1v104c-30 5-62-2-96 1s-66 3-95-1z" fill="none" stroke={INK} strokeWidth="1.2" />
      {/* 左右の軸 */}
      <rect x="9" y="8" width="15" height="112" rx="5" fill="none" stroke={INK} strokeWidth="1.3" />
      <rect x="211" y="8" width="15" height="112" rx="5" fill="none" stroke={INK} strokeWidth="1.3" />
      {rollHatch(10)}
      {rollHatch(212)}
      {/* 段の区切り */}
      <path d="M92 30v86M95 30v86M147 30v86M150 30v86" stroke={INK} strokeWidth="0.8" />
      <text x="117.5" y="24" textAnchor="middle" fontSize="9.5" fontWeight="700" letterSpacing="2" fill={INK} fontFamily="'Hiragino Sans',sans-serif">完全版</text>
      <g fontFamily={MINCHO} fontWeight="700" fontSize="34" fill={INK} textAnchor="middle">
        <text x="62" y="64">全</text>
        <text x="62" y="104">史</text>
        <text x="121" y="64">戦</text>
        <text x="121" y="104">略</text>
        <text x="177" y="64">経</text>
        <text x="177" y="104">営</text>
      </g>
      <NpMark x={4} y={3} s={17} />
      <WeeklyBadge x={196} y={0} s={34} />
    </svg>
  )
}

/** 『頭に汗 かいてる?』の横顔サムネ。viewBox 200x104。 */
export function HeadArt({ className, bg = '#f5f03e' }: { className?: string; bg?: string }) {
  return (
    <svg viewBox="0 0 200 104" preserveAspectRatio="xMidYMid slice" className={className} aria-hidden>
      <rect width="200" height="104" fill={bg} />
      {/* 白い横顔（左向き） */}
      <path
        d="M36 104c3-8 2-14-4-18-4-2-6-5-3-8-4-2-3-5-1-7-3-2-4-5 0-8 4-3 3-8 2-13C28 30 50 10 82 8c34-2 64 18 70 48 4 20-4 34-12 48z"
        fill="#fff"
      />
      <text x="56" y="70" fontSize="42" fontWeight="900" fill={OLIVE} fontFamily="'Hiragino Sans',sans-serif">頭</text>
      <text x="99" y="64" fontSize="24" fontWeight="800" fill={OLIVE} fontFamily="'Hiragino Sans',sans-serif">に汗</text>
      <g stroke={OLIVE} strokeWidth="3" strokeLinecap="round" fill="none">
        <path d="M149 62c-2 3-4 6-6 7" />
        <path d="M155 62c3 3 5 6 6 9" />
        <path d="M152 56v4" />
      </g>
      <text x="80" y="94" fontSize="13" fontWeight="800" fill={OLIVE} fontFamily="'Hiragino Sans',sans-serif">かいてる?</text>
      <text x="147" y="96" fontSize="6.5" fontWeight="700" fill={OLIVE} fontFamily="'Hiragino Sans',sans-serif">『経営戦略全史』</text>
      <NpMark x={7} y={6} s={14} color={OLIVE} />
      <WeeklyBadge x={165} y={2} s={30} color={OLIVE} />
    </svg>
  )
}

/** 「週末ワールド」の小さなロゴ。 */
function WorldLogo({ x, y }: { x: number; y: number }) {
  return (
    <g transform={`translate(${x} ${y})`}>
      <circle cx="17" cy="4" r="6" fill="#fff" stroke="#222" strokeWidth="0.8" />
      <path d="M11 4h12M17 -2v12" stroke="#222" strokeWidth="0.5" />
      <text x="13" y="6" fontSize="4.5" fontWeight="800" fill="#222" fontFamily="'Hiragino Sans',sans-serif">週末</text>
      <text
        x="0"
        y="17"
        fontSize="10"
        fontWeight="900"
        fill="#fff"
        stroke="#222"
        strokeWidth="0.9"
        paintOrder="stroke"
        fontFamily="'Hiragino Sans',sans-serif"
      >
        ワールド
      </text>
    </g>
  )
}

/** 【レアアース】の写真サムネ（写真部分は面、帯の文字は描く）。 */
export function RareEarthArt({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 200 104" preserveAspectRatio="xMidYMid slice" className={className} aria-hidden>
      <rect width="200" height="104" fill="#f9cf02" />
      <rect x="4" y="4" width="192" height="74" rx="3" fill="#946f59" />
      <path d="M4 7c0-2 1-3 3-3h186c2 0 3 1 3 3v28L150 44 20 47 4 40z" fill="#d9ded9" />
      <path d="M4 40l16 7 130-3 46-9v8l-46 9-130 3-16-6z" fill="#4c4a47" />
      <rect x="10" y="56" width="16" height="4" fill="#6b3f2a" />
      <rect x="70" y="58" width="18" height="4" fill="#6b3f2a" />
      <rect x="120" y="54" width="20" height="24" fill="#7d8a88" opacity="0.6" />
      <text x="8" y="94" fontSize="8" fontWeight="800" fill="#2f2a11" fontFamily="'Hiragino Sans',sans-serif">
        脱中国依存のロールモデル日本
      </text>
      <WorldLogo x={150} y={82} />
    </svg>
  )
}

/** 【最新研究】のスマホ写真サムネ。画面の文字は描く。 */
export function PhoneArt({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 200 104" preserveAspectRatio="xMidYMid slice" className={className} aria-hidden>
      <rect width="200" height="104" fill="#348e03" />
      <rect x="4" y="4" width="192" height="74" rx="3" fill="#daa85f" />
      <path d="M150 4h43c2 0 3 1 3 3v71h-40z" fill="#dea585" />
      {/* 斜めのスマホ */}
      <g transform="rotate(-24 110 44)">
        <rect x="46" y="10" width="140" height="68" rx="10" fill="#1f2326" />
        <rect x="42" y="8" width="148" height="72" rx="12" fill="none" stroke="#7b8288" strokeWidth="2" />
        <text x="84" y="34" fontSize="9" fontWeight="600" fill="#fff" fontFamily="'Avenir Next',sans-serif">Ask Me Anything</text>
        <text x="84" y="41" fontSize="3.6" fill="#c9ccd0" fontFamily="'Avenir Next',sans-serif">All The Top AI Models In One Place</text>
        <rect x="64" y="48" width="38" height="6" rx="2" fill="#30353a" />
        <rect x="106" y="48" width="18" height="6" rx="2" fill="#30353a" />
        <rect x="128" y="48" width="22" height="6" rx="2" fill="#30353a" />
        <rect x="70" y="58" width="24" height="6" rx="2" fill="#30353a" />
        <rect x="98" y="58" width="16" height="6" rx="2" fill="#30353a" />
        <rect x="118" y="58" width="16" height="6" rx="2" fill="#30353a" />
        <text x="66" y="52.5" fontSize="3.4" fill="#fff">Message Gab AI</text>
        <text x="74" y="62.5" fontSize="3.4" fill="#fff">Summarize</text>
        <text x="108" y="52.5" fontSize="3.4" fill="#fff">Write</text>
        <text x="130" y="52.5" fontSize="3.4" fill="#fff">Analyze</text>
      </g>
      <NpMark x={6} y={6} s={12} color="#fff" />
      <text x="8" y="94" fontSize="8.5" fontWeight="800" fill="#fff" fontFamily="'Hiragino Sans',sans-serif">
        AIが票を動かす時代に
      </text>
      <WorldLogo x={150} y={82} />
    </svg>
  )
}

/** 三谷宏治さんの顔写真（写真なので単純な図形で代替）。 */
export function PortraitArt({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 188 188" className={className} aria-hidden>
      <circle cx="94" cy="94" r="94" fill="#5b5919" />
      <circle cx="94" cy="94" r="89.5" fill="#0f0c0a" />
      <clipPath id="pf">
        <circle cx="94" cy="94" r="89.5" />
      </clipPath>
      <g clipPath="url(#pf)">
        <path d="M30 188c6-30 30-44 64-44s58 14 64 44z" fill="#c9603a" />
        <path d="M70 146l24 30 24-30z" fill="#9c8f86" />
        <ellipse cx="94" cy="98" rx="30" ry="38" fill="#b98763" />
        <path d="M62 86c-2-30 14-44 32-44s34 12 32 42c-6-14-16-20-32-20s-26 8-32 22z" fill="#1c1714" />
        <g fill="none" stroke="#2a1d18" strokeWidth="2.4">
          <rect x="70" y="90" width="20" height="11" rx="3" />
          <rect x="98" y="90" width="20" height="11" rx="3" />
          <path d="M90 95h8" />
        </g>
        <path d="M84 122c6 3 14 3 20 0" stroke="#6b3f2a" strokeWidth="2" fill="none" />
      </g>
    </svg>
  )
}

/** PREMIUM ロゴの斜線マーク（高さ 35）。 */
export function PremiumMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 40 36" className={className} aria-hidden>
      <g stroke="#1a1a1a" strokeWidth="3.2" strokeLinecap="round" fill="none">
        <path d="M3 18 17 4" />
        <path d="M5 24 22 7" />
        <path d="M9 28 27 10" />
        <path d="M14 32 31 15" />
        <path d="M20 34 36 18" />
        <path d="M21 3 25 1" />
      </g>
    </svg>
  )
}
