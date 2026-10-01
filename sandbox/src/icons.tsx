import type { ReactNode } from 'react'

type IconProps = { size?: number; className?: string; strokeWidth?: number; children: ReactNode }

/** 線画アイコンの共通枠（lucide 風・viewBox 24）。 */
export function Line({ size = 14, className, strokeWidth = 1.7, children }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={className}
    >
      {children}
    </svg>
  )
}

export const HomeIcon = (p: { size?: number }) => (
  <Line {...p}>
    <path d="M3 10.6 12 3.2l9 7.4" />
    <path d="M5.6 9.6V20.8h12.8V9.6" />
    <path d="M9.6 20.8v-5.6h4.8v5.6" />
  </Line>
)

export const CrownIcon = (p: { size?: number }) => (
  <Line {...p}>
    <path d="M3.4 17.2 2.2 6.6l5.4 3.6L12 3.4l4.4 6.8 5.4-3.6-1.2 10.6z" />
    <path d="M4.4 20.4h15.2" />
  </Line>
)

export const GaugeIcon = (p: { size?: number }) => (
  <Line {...p}>
    {/* 速度計。下端が水平に切れた円 */}
    <path d="M7.62 21A9.65 9.65 0 1 1 16.38 21Z" />
    {/* 円の内側上部に並ぶ目盛り */}
    <path d="M12 4.4v1.6M6.6 7 8.1 8.5M17.4 7l-1.5 1.5M4.1 12.4h1.6M19.9 12.4h-1.6" />
    {/* 中心から右上へ伸びる短い針 */}
    <path d="M12.6 11.8 15.8 8.6" />
    <circle cx="12" cy="12.4" r="1.15" fill="currentColor" stroke="none" />
  </Line>
)

export const PenSquareIcon = (p: { size?: number }) => (
  <Line {...p}>
    <path d="M20.2 12.6v8H3.8v-17h8" />
    <path d="m16.9 3.3 3.8 3.8-7.9 7.9H9.1v-3.8z" />
  </Line>
)

export const TableIcon = (p: { size?: number }) => (
  <Line {...p}>
    {/* 3x3 の表。外枠＋横2本・縦2本の格子 */}
    <rect x="3.2" y="5.1" width="17.6" height="13.8" rx="1.1" />
    <path d="M3.2 9.7h17.6M3.2 14.3h17.6M9.07 5.1v13.8M14.93 5.1v13.8" />
  </Line>
)

export const IdCardIcon = (p: { size?: number }) => (
  <Line {...p}>
    {/* 身分証カード。左に小さな塗りの四角、その右に短い横線が3本 */}
    <rect x="3.2" y="3.4" width="17.6" height="17.2" rx="1.1" />
    <rect x="6.7" y="7.9" width="2.1" height="2.1" fill="currentColor" stroke="none" />
    <rect x="6.7" y="11" width="2.1" height="2.1" fill="currentColor" stroke="none" />
    <rect x="6.7" y="14.1" width="2.1" height="2.1" fill="currentColor" stroke="none" />
    <path d="M11 8.95h6.4M11 12.05h6.4M11 15.15h6.4" />
  </Line>
)

export const CheckCircleIcon = (p: { size?: number }) => (
  <Line {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="m8.2 12.2 2.8 2.8 5-6" />
  </Line>
)

export const AlertTriangleIcon = (p: { size?: number }) => (
  <Line {...p}>
    <path d="M12 3.6 21.2 20H2.8z" />
    <path d="M12 9.8v4.4M12 17.4h.01" />
  </Line>
)

export const UserIcon = (p: { size?: number }) => (
  <Line {...p}>
    <circle cx="12" cy="8" r="3.6" />
    <path d="M4.8 20.4c0-3.9 3.2-6.2 7.2-6.2s7.2 2.3 7.2 6.2" />
  </Line>
)

export const BotIcon = (p: { size?: number }) => (
  <Line {...p}>
    <rect x="3.2" y="4.4" width="17.6" height="15.4" rx="3.2" />
    <path d="M8.8 10.4h.01M15.2 10.4h.01" />
    <path d="M9 14.8c.9.8 1.9 1.2 3 1.2s2.1-.4 3-1.2" />
  </Line>
)

export const ChevronDownIcon = ({ size = 16, className }: { size?: number; className?: string }) => (
  <Line size={size} className={className} strokeWidth={2.4}>
    <path d="m4 8.5 8 8 8-8" />
  </Line>
)

export const ChevronLeftIcon = ({ size = 10, className }: { size?: number; className?: string }) => (
  <Line size={size} className={className} strokeWidth={2.2}>
    <path d="m15 4-7 8 7 8" />
  </Line>
)

export const BookIcon = (p: { size?: number }) => (
  <Line {...p} strokeWidth={1.6}>
    <path d="M5.4 3h13.2v18H5.4z" />
    <path d="M5.4 6.2h13.2" />
    <path d="M13.6 3v6l1.9-1.6L17.4 9V3" />
  </Line>
)

export const ForkIcon = (p: { size?: number }) => (
  <Line {...p} strokeWidth={1.6}>
    <circle cx="6.6" cy="4.6" r="1.9" />
    <circle cx="17.4" cy="4.6" r="1.9" />
    <circle cx="12" cy="19.4" r="1.9" />
    <path d="M6.6 6.5c0 4.2 5.4 4.2 5.4 8.4M17.4 6.5c0 4.2-5.4 4.2-5.4 8.4" />
  </Line>
)

export const GlobeIcon = (p: { size?: number }) => (
  <Line {...p} strokeWidth={1.6}>
    <circle cx="12" cy="12" r="9" />
    <path d="M3 12h18" />
    <path d="M12 3c2.6 2.6 3.9 5.6 3.9 9S14.6 18.4 12 21c-2.6-2.6-3.9-5.6-3.9-9S9.4 5.6 12 3z" />
  </Line>
)

export const UploadIcon = (p: { size?: number }) => (
  <Line {...p}>
    <path d="M12 15.6V3.8" />
    <path d="m7.6 8.2 4.4-4.4 4.4 4.4" />
    <path d="M3.8 15.6v4.6h16.4v-4.6" />
  </Line>
)

export const GearIcon = ({ size = 20 }: { size?: number }) => (
  <Line size={size} strokeWidth={1.8}>
    <circle cx="12" cy="12" r="3.2" />
    <path d="M19.1 13.9a1.6 1.6 0 0 0 .32 1.77l.06.06a1.94 1.94 0 1 1-2.74 2.74l-.06-.06a1.6 1.6 0 0 0-1.77-.32 1.6 1.6 0 0 0-.97 1.47v.17a1.94 1.94 0 1 1-3.88 0v-.09a1.6 1.6 0 0 0-1.05-1.47 1.6 1.6 0 0 0-1.77.32l-.06.06a1.94 1.94 0 1 1-2.74-2.74l.06-.06a1.6 1.6 0 0 0 .32-1.77 1.6 1.6 0 0 0-1.47-.97h-.17a1.94 1.94 0 1 1 0-3.88h.09a1.6 1.6 0 0 0 1.47-1.05 1.6 1.6 0 0 0-.32-1.77l-.06-.06a1.94 1.94 0 1 1 2.74-2.74l.06.06a1.6 1.6 0 0 0 1.77.32h.08a1.6 1.6 0 0 0 .97-1.47v-.17a1.94 1.94 0 1 1 3.88 0v.09a1.6 1.6 0 0 0 .97 1.47 1.6 1.6 0 0 0 1.77-.32l.06-.06a1.94 1.94 0 1 1 2.74 2.74l-.06.06a1.6 1.6 0 0 0-.32 1.77v.08a1.6 1.6 0 0 0 1.47.97h.17a1.94 1.94 0 1 1 0 3.88h-.09a1.6 1.6 0 0 0-1.47.97z" />
  </Line>
)

/** Ant Design Pro のロゴ（青い開いた菱形の輪郭＋赤い点と山形）。 */
export function LogoMark({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 28 28" aria-hidden className="shrink-0">
      <defs>
        <linearGradient id="logo-blue" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#2ec7ff" />
          <stop offset="50%" stopColor="#1282ff" />
          <stop offset="100%" stopColor="#0a62ff" />
        </linearGradient>
        <linearGradient id="logo-red" x1="0" y1="0" x2="0.6" y2="1">
          <stop offset="0%" stopColor="#fa7a6e" />
          <stop offset="55%" stopColor="#f7404e" />
          <stop offset="100%" stopColor="#f51d2c" />
        </linearGradient>
      </defs>
      {/* 右上と右下を開いた角丸菱形の輪郭。右の角は赤い山形が担う */}
      <path
        d="M19.84 6.7 15.27 2.13A1.8 1.8 0 0 0 12.73 2.13L2.13 12.73A1.8 1.8 0 0 0 2.13 15.27L12.73 25.87A1.8 1.8 0 0 0 15.27 25.87L19.84 21.3"
        fill="none"
        stroke="url(#logo-blue)"
        strokeWidth="3.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="14" cy="13.9" r="3" fill="url(#logo-red)" />
      <path
        d="M21.6 9.5 26 13.9 21.6 18.3"
        fill="none"
        stroke="url(#logo-red)"
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

const ROBOT_OUTLINE = '#2150b7'
const ROBOT_BG = '#a6dbff'
const ROBOT_BLUE = '#43bcff'

/** 参照のアバター画像の代替。線画のロボット（144pxの原寸で設計）。 */
export function RobotMark({ size = 144 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 144 144" aria-hidden className="shrink-0">
      <circle cx="72" cy="72" r="72" fill={ROBOT_BG} />
      <g
        fill="none"
        stroke={ROBOT_OUTLINE}
        strokeWidth="2.5"
        strokeLinejoin="round"
        strokeLinecap="round"
      >
        {/* 肩と襟 */}
        <path
          d="M45 104C40 108 37 112 35 117 31 124 29 134 28.5 145L104 145C103.5 134 101 124 97 117 95 112 91 108 86 104Z"
          fill={ROBOT_BG}
        />
        <path d="M46 98 48.5 109.5 61 116 68.5 110.5 76 116 85.5 109.5 88 98Z" fill="#ffffff" />
        {/* ノートPCの天板 */}
        <path d="M6 118 56 117 61 145 10 145Z" fill={ROBOT_BLUE} />
        {/* 手元 */}
        <path d="M67 145C67 137.5 72.2 132.5 78.6 132.5L78.6 145Z" fill={ROBOT_BLUE} />
        <path d="M78.6 133 96 133" />
        {/* 触角 */}
        <path d="M39 21.5C46 21.5 47.6 26 48.6 31.5 49.1 34.3 49.6 36.4 50.2 38.5" />
        <path d="M71 17C78 17 79.9 22 80.9 27.8 81.4 30.7 82 33.8 82.6 36.5" />
        {/* フード */}
        <path
          d="M22 78C22 48 41 27 67 27 77 27 85.5 29.2 92.5 33.2 96.4 35.4 99.2 34.2 103 38 110 45 114 59 114 76 114 95 104 110.5 88 110.5L44 110.5C29 110.5 22 95.5 22 78Z"
          fill={ROBOT_BLUE}
        />
        {/* 顔 */}
        <ellipse cx="66" cy="79" rx="35.5" ry="28.5" fill="#ffffff" />
        {/* 口 */}
        <path d="M62 83.5C57.6 85 56.6 90.6 61.5 92" />
      </g>
      <circle cx="39" cy="21.5" r="3.4" fill={ROBOT_OUTLINE} />
      <circle cx="71" cy="17" r="3.4" fill={ROBOT_OUTLINE} />
      <circle cx="46.2" cy="82.2" r="3.1" fill={ROBOT_OUTLINE} />
      <circle cx="76.8" cy="82.2" r="3.1" fill={ROBOT_OUTLINE} />
      <circle cx="68.1" cy="119.5" r="1.6" fill={ROBOT_OUTLINE} />
      <rect x="18" y="104.5" width="7" height="7" rx="1.6" fill={ROBOT_BLUE} />
      <path d="M117.5 103.5 124.5 97.5 125 103.5Z" fill={ROBOT_BLUE} />
      <circle cx="111.7" cy="120.8" r="3.4" fill={ROBOT_BLUE} />
    </svg>
  )
}

export const CalendarIcon = ({ size = 14 }: { size?: number }) => (
  <Line size={size} strokeWidth={1.6}>
    <rect x="3.4" y="5.2" width="17.2" height="15.4" rx="1.6" />
    <path d="M3.4 9.8h17.2M8.2 3.4v3.6M15.8 3.4v3.6" />
  </Line>
)

export const ClockIcon = ({ size = 14 }: { size?: number }) => (
  <Line size={size} strokeWidth={1.6}>
    <circle cx="12" cy="12" r="8.8" />
    <path d="M12 7v5.4l3.4 2" />
  </Line>
)

export const ArrowRightIcon = ({ size = 12 }: { size?: number }) => (
  <Line size={size} strokeWidth={1.5}>
    <path d="M1.2 12h21.6" />
    <path d="m16.4 6.6 6.4 5.4-6.4 5.4" />
  </Line>
)

export const PlusIcon = ({ size = 12 }: { size?: number }) => (
  <Line size={size} strokeWidth={1.8}>
    <path d="M12 4.5v15M4.5 12h15" />
  </Line>
)

/** サイドバー下部の薄い三角メッシュのウォーターマーク（左下と右端に淡い青のにじみ）。 */
export function SiderWatermark({ className }: { className?: string }) {
  return (
    <svg
      width="256"
      height="320"
      viewBox="0 0 256 320"
      aria-hidden
      className={className}
      preserveAspectRatio="none"
    >
      <defs>
        <pattern id="wm-tri" x="25" y="37.05" width="55.4" height="63" patternUnits="userSpaceOnUse">
          <g fill="none" stroke="#c6daee" strokeWidth="0.55">
            {/* 縦の辺（頂点の手前で切れる）。左列は毎段、中列は一段おき。 */}
            <path d="M0 4V27.5M0 35.5V59M55.4 4V27.5M55.4 35.5V59M27.7 0V11.75M27.7 51.25V63" />
            {/* 斜辺（右下がり4本・右上がり4本）。頂点で少し切る。 */}
            <path
              strokeDasharray="23.6 8.26"
              strokeDashoffset="-4.13"
              d="M-27.7 -47.25L83.1 15.75 M-27.7 -15.75L83.1 47.25 M-27.7 15.75L83.1 78.75 M-27.7 47.25L83.1 110.25 M-27.7 15.75L83.1 -47.25 M-27.7 47.25L83.1 -15.75 M-27.7 78.75L83.1 15.75 M-27.7 110.25L83.1 47.25"
            />
          </g>
        </pattern>
        <linearGradient id="wm-mesh-fade" x1="0" y1="1" x2="1" y2="0">
          <stop offset="0%" stopColor="#ffffff" stopOpacity="1" />
          <stop offset="100%" stopColor="#ffffff" stopOpacity="0.1" />
        </linearGradient>
        <linearGradient id="wm-top-fade" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#000000" stopOpacity="1" />
          <stop offset="29.7%" stopColor="#000000" stopOpacity="1" />
          <stop offset="67%" stopColor="#000000" stopOpacity="0" />
        </linearGradient>
        <mask id="wm-mesh-mask">
          <rect width="256" height="320" fill="url(#wm-mesh-fade)" />
          {/* 上端 95px までは隠し、そこから 120px かけて現れる */}
          <rect width="256" height="320" fill="url(#wm-top-fade)" />
        </mask>
        <radialGradient
          id="wm-wash-a"
          gradientUnits="userSpaceOnUse"
          cx="0"
          cy="320"
          r="230"
        >
          <stop offset="0%" stopColor="#e9eef5" stopOpacity="1" />
          <stop offset="100%" stopColor="#e9eef5" stopOpacity="0" />
        </radialGradient>
        <radialGradient
          id="wm-wash-b"
          gradientUnits="userSpaceOnUse"
          cx="256"
          cy="54"
          r="115"
        >
          <stop offset="0%" stopColor="#e8eff6" stopOpacity="1" />
          <stop offset="100%" stopColor="#e8eff6" stopOpacity="0" />
        </radialGradient>
      </defs>
      <rect width="256" height="320" fill="url(#wm-wash-a)" />
      <rect width="256" height="320" fill="url(#wm-wash-b)" />
      <rect width="256" height="320" fill="url(#wm-tri)" mask="url(#wm-mesh-mask)" />
    </svg>
  )
}
