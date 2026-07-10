/** React Router v7 future flags, shared by the app router (main.tsx) and
 * every test's MemoryRouter so the two stay in sync and the suite doesn't
 * warn about upcoming v7 behavior we haven't opted into.
 * See https://reactrouter.com/v6/upgrading/future */
export const ROUTER_FUTURE_FLAGS = {
  v7_startTransition: true,
  v7_relativeSplatPath: true,
} as const;
