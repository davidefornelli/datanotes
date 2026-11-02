import type { JSX } from "preact";
import { useApp } from "../state";

/** (G5) The bar shown while the owner views the database as a token. */
export function ViewAsBar(): JSX.Element | null {
  const { viewAs, setViewAs } = useApp();
  if (!viewAs) return null;
  return (
    <div class="shell-viewas" role="status">
      Viewing as <strong>{viewAs}</strong>: read only.{" "}
      <button type="button" onClick={() => setViewAs(null)}>
        Stop
      </button>
    </div>
  );
}
