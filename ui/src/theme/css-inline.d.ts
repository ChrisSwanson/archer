/** A stylesheet imported as minified text (`./x.css?inline`), for `on-demand-styles.ts`. */
declare module "*.css?inline" {
  const css: string;
  export default css;
}
