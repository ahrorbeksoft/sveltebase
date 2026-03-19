import type { Snippet } from "svelte";
import type { ButtonVariant } from "./types.js";
type Props = {
    children?: Snippet;
    href?: string;
    type?: "button" | "submit" | "reset";
    variant?: ButtonVariant;
};
declare const Button: import("svelte").Component<Props, {}, "">;
type Button = ReturnType<typeof Button>;
export default Button;
//# sourceMappingURL=Button.svelte.d.ts.map