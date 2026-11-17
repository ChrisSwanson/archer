/** GitHub project Pages by default; use / for a custom domain or local root. */
export const siteBase =
  `/${(process.env.ARCHER_DOCS_BASE ?? "/archer/").split("/").filter(Boolean).join("/")}/`.replace(/^\/\/$/, "/");
