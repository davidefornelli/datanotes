import type { ComponentChildren, JSX } from "preact";
import { Toasts } from "../components";
import { Header } from "./Header";
import { Sidebar } from "./Sidebar";
import { ViewAsBar } from "./ViewAsBar";

/** Header, the view-as bar, the sidebar and the routed screen, with the toasts above them. */
export function Layout(props: { children: ComponentChildren }): JSX.Element {
  return (
    <div class="layout">
      <div class="layout-header">
        <Header />
      </div>
      <div class="layout-bar">
        <ViewAsBar />
      </div>
      <aside class="layout-sidebar">
        <Sidebar />
      </aside>
      <main class="layout-main">{props.children}</main>
      <Toasts />
    </div>
  );
}
