// The database browser's entry point (GET /datanotes/ui/app.js).
import { render } from "preact";
// first: the variables and base styles, which the components' styles build on
import "./styles.css";
import { App } from "./app";

render(<App />, document.getElementById("app")!);
