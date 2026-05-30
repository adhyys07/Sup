type IconProps = {
  name: keyof typeof paths;
};

const paths = {
  activity: <path d="M22 12h-4l-3 8-6-16-3 8H2" />,
  arrowLeft: <>
    <path d="M19 12H5" />
    <path d="m12 19-7-7 7-7" />
  </>,
  close: <>
    <path d="M18 6 6 18" />
    <path d="m6 6 12 12" />
  </>,
  filter: <path d="M22 3H2l8 9.5V20l4 2v-9.5L22 3Z" />,
  home: <>
    <path d="m3 11 9-8 9 8" />
    <path d="M5 10v10h14V10" />
  </>,
  layout: <>
    <rect x="3" y="3" width="7" height="7" rx="1" />
    <rect x="14" y="3" width="7" height="7" rx="1" />
    <rect x="3" y="14" width="7" height="7" rx="1" />
    <rect x="14" y="14" width="7" height="7" rx="1" />
  </>,
  logout: <>
    <path d="M10 17l5-5-5-5" />
    <path d="M15 12H3" />
    <path d="M12 4h7v16h-7" />
  </>,
  refresh: <>
    <path d="M21 12a9 9 0 0 1-15.4 6.4" />
    <path d="M3 12A9 9 0 0 1 18.4 5.6" />
    <path d="M18 2v4h-4" />
    <path d="M6 22v-4h4" />
  </>,
  user: <>
    <circle cx="12" cy="8" r="4" />
    <path d="M4 21a8 8 0 0 1 16 0" />
  </>,
  users: <>
    <path d="M16 21a6 6 0 0 0-12 0" />
    <circle cx="10" cy="8" r="4" />
    <path d="M22 21a5 5 0 0 0-5-5" />
    <path d="M17 4a4 4 0 0 1 0 8" />
  </>,
  video: <>
    <rect x="3" y="6" width="13" height="12" rx="2" />
    <path d="m16 10 5-3v10l-5-3Z" />
  </>
};

export function Icon({ name }: IconProps) {
  return (
    <svg className="icon" viewBox="0 0 24 24" aria-hidden="true">
      {paths[name]}
    </svg>
  );
}
