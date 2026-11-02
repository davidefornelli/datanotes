// The router outlet: the route of the URL hash picks the screen. Not signed in: the login page.
// Owner-only screens show a notice to a named token and while the owner views as one.

import type { JSX } from "preact";
import { Button, EmptyState, ErrorBox, Spinner } from "./components";
import type { Route, RouteName } from "./lib/router";
import { ConfigScreen, ExtensionsScreen, MaintenanceScreen, SemanticScreen, StatusScreen, WebhooksScreen } from "./screens/admin";
import { ChangesScreen, DatabaseHistoryScreen, JournalScreen, TableHistoryScreen } from "./screens/history";
import { NewRowScreen, NoteScreen, RowScreen, RowsScreen } from "./screens/rows";
import { BaseScreen, NewTableScreen, NewViewScreen, TableScreen, ViewScreen } from "./screens/schema";
import { SettingsScreen } from "./screens/settings";
import { MatrixScreen, SessionScreen, TokenScreen, TokensScreen, UserScreen, UsersScreen } from "./screens/tokens";
import { Home, Layout, Login, OpenScreen, OpsScreen } from "./shell";
import { AppProvider, useApp, useRoute, useSession } from "./state";

type Screen = (props: { route: Route }) => JSX.Element;

const SCREENS: Record<Exclude<RouteName, "login" | "not-found">, Screen> = {
  home: () => <Home />,
  open: OpenScreen,
  ops: OpsScreen,
  op: OpsScreen,
  rows: RowsScreen,
  row: RowScreen,
  "new-row": NewRowScreen,
  note: NoteScreen,
  table: TableScreen,
  view: ViewScreen,
  base: BaseScreen,
  "new-table": NewTableScreen,
  "new-view": NewViewScreen,
  tokens: TokensScreen,
  token: TokenScreen,
  matrix: MatrixScreen,
  users: UsersScreen,
  user: UserScreen,
  session: SessionScreen,
  journal: JournalScreen,
  changes: ChangesScreen,
  "table-history": TableHistoryScreen,
  "database-history": DatabaseHistoryScreen,
  config: ConfigScreen,
  settings: SettingsScreen,
  webhooks: WebhooksScreen,
  extensions: ExtensionsScreen,
  status: StatusScreen,
  semantic: SemanticScreen,
  maintenance: MaintenanceScreen,
};

/** Screens the engine reserves to the owner (named tokens get 403 there). */
export const OWNER_ROUTES: ReadonlySet<RouteName> = new Set<RouteName>(["tokens", "token", "matrix", "users", "user", "session", "settings", "status"]);

function Routed(props: { route: Route }): JSX.Element {
  const { isOwner, viewAs } = useApp();
  const { route } = props;
  if (route.name === "not-found" || route.name === "login") return <EmptyState title="This page does not exist." />;
  if (OWNER_ROUTES.has(route.name) && (!isOwner || viewAs)) return <EmptyState title="This page is the owner's." />;
  const S = SCREENS[route.name];
  // a new key per route remounts the screen, so no state leaks from one object to another
  return <S key={`${route.name}:${JSON.stringify(route.params)}`} route={route} />;
}

function Root(): JSX.Element {
  const session = useSession();
  const route = useRoute();
  if (session.phase === "loading") return <Spinner />;
  if (session.phase === "unreachable") {
    return (
      <div class="shell-unreachable">
        <ErrorBox title="The engine does not answer" body={{ error: session.message, hint: "Check that the engine runs, then try again." }} />
        <Button kind="primary" onClick={session.retry}>
          Try again
        </Button>
      </div>
    );
  }
  if (session.phase !== "ready" || route.name === "login") return <Login route={route} />;
  return (
    <Layout>
      <Routed route={route} />
    </Layout>
  );
}

export function App(): JSX.Element {
  return (
    <AppProvider>
      <Root />
    </AppProvider>
  );
}
