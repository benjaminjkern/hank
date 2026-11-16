import "styled-components";
import type { Theme } from "../shared/theme";

declare module "styled-components" {
  export interface DefaultTheme extends Theme {}
}
