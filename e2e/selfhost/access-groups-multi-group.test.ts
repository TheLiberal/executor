// Selfhost-only: one org connection granted to SEVERAL access groups at once.
//
// The product promise under test: a restricted workspace connection is usable
// by a member of ANY of its groups (OR semantics), invisible to everyone
// outside all of them, and an admin can edit the grant set in place from the
// Access groups page — with the change applying to members without a session
// restart. Self-host because it needs several non-admin members in one org,
// which only the invite plane mints freely (cloud caps free-plan seats).
//
// The org is SHARED with every other selfhost scenario in the run: every
// resource is suffixed per run and removed in `Effect.ensuring`.
import { randomBytes } from "node:crypto";

import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { composePluginApi } from "@executor-js/api/server";
import { openApiHttpPlugin } from "@executor-js/plugin-openapi/api";
import { AuthTemplateSlug, ConnectionName, IntegrationSlug } from "@executor-js/sdk/shared";

import { scenario } from "../src/scenario";
import { Api, Browser, Target } from "../src/services";
import type { Identity } from "../src/target";
import { visit } from "../src/surfaces/browser";
import { createInvitedIdentity } from "../targets/selfhost";

const api = composePluginApi([openApiHttpPlugin()] as const);

const TEMPLATE_API_KEY = AuthTemplateSlug.make("apiKey");

/** A one-operation spec — the connection only needs to EXIST; nothing is
 *  invoked. Never contacted over the network. */
const pingSpec = JSON.stringify({
  openapi: "3.0.3",
  info: { title: "Ping API", version: "1.0.0" },
  paths: {
    "/ping": {
      get: { operationId: "ping", summary: "Ping", responses: { "200": { description: "ok" } } },
    },
  },
});

/** The admin plane over raw fetch: the access-groups API is deliberately not
 *  part of the shared member `ExecutorApi`, so the typed client cannot reach
 *  it — the operator's session cookie is the credential. */
const adminFetch = (baseUrl: string, admin: Identity) => {
  const cookie = admin.headers?.cookie ?? "";
  const origin = new URL(baseUrl).origin;
  return async <T>(
    path: string,
    init?: { readonly method?: string; readonly body?: unknown },
  ): Promise<T> => {
    const response = await fetch(new URL(path, baseUrl), {
      method: init?.method ?? "GET",
      headers: { "content-type": "application/json", cookie, origin },
      body: init?.body === undefined ? undefined : JSON.stringify(init.body),
    });
    if (!response.ok) {
      throw new Error(`${init?.method ?? "GET"} ${path} failed (${response.status})`);
    }
    return (await response.json()) as T;
  };
};

/** The host principal id the roster is keyed by. A member earns their
 *  `subject` row on their first executor-plane request, so each invited
 *  identity makes one product read before it is looked up here. */
const subjectOf = async (
  call: ReturnType<typeof adminFetch>,
  identity: Identity,
): Promise<string> => {
  const email = identity.credentials?.email;
  if (!email) throw new Error(`identity ${identity.label} has no email`);
  const body = await call<
    { readonly user?: { readonly externalId?: string } } & { externalId?: string }
  >(`/api/admin/users/${encodeURIComponent(email)}`);
  const externalId = body.user?.externalId ?? body.externalId;
  if (typeof externalId !== "string") throw new Error(`no externalId for ${email}`);
  return externalId;
};

scenario(
  "Access groups · one connection granted to two groups is usable by either roster and editable in place",
  { timeout: 240_000 },
  Effect.gen(function* () {
    const target = yield* Target;
    const browser = yield* Browser;
    const { client: apiClient } = yield* Api;

    const admin = yield* target.newIdentity();
    const adminApi = yield* apiClient(api, admin);
    const call = adminFetch(target.baseUrl, admin);

    const suffix = randomBytes(4).toString("hex");
    const integration = IntegrationSlug.make(`agmulti${suffix}`);
    const connection = ConnectionName.make(`xero${suffix}`);
    const financeName = `finance-${suffix}`;
    const execsName = `execs-${suffix}`;

    // Three members with no admin role: one per group, one in neither.
    const [finance, exec, outsider] = yield* Effect.promise(() =>
      Promise.all(
        ["finance", "exec", "outsider"].map(async (prefix) => {
          const identity = await createInvitedIdentity(target.baseUrl, admin, {
            role: "member",
            emailPrefix: `ag-${prefix}-${suffix}`,
          });
          const touch = await fetch(new URL("/api/integrations", target.baseUrl), {
            headers: { cookie: identity.headers?.cookie ?? "" },
          });
          if (!touch.ok) throw new Error(`seeding read failed for ${identity.label}`);
          return identity;
        }),
      ),
    );
    const financeApi = yield* apiClient(api, finance!);
    const execApi = yield* apiClient(api, exec!);
    const outsiderApi = yield* apiClient(api, outsider!);

    const seesConnection = (client: typeof adminApi) =>
      client.connections
        .list({ query: { integration } })
        .pipe(Effect.map((rows) => rows.some((row) => String(row.name) === String(connection))));

    const groupIds: string[] = [];

    const cleanup = Effect.gen(function* () {
      yield* Effect.promise(() =>
        call(`/api/admin/access-group-restrictions/${integration}/${connection}`, {
          method: "DELETE",
        }),
      ).pipe(Effect.ignore);
      yield* Effect.forEach(groupIds, (id) =>
        Effect.promise(() => call(`/api/admin/access-groups/${id}`, { method: "DELETE" })).pipe(
          Effect.ignore,
        ),
      );
      yield* adminApi.connections
        .remove({ params: { owner: "org", integration, name: connection } })
        .pipe(Effect.ignore);
      yield* adminApi.openapi.removeSpec({ params: { slug: integration } }).pipe(Effect.ignore);
    }).pipe(Effect.ignore);

    yield* Effect.gen(function* () {
      yield* adminApi.openapi.addSpec({
        payload: {
          spec: { kind: "blob", value: pingSpec },
          slug: integration,
          baseUrl: "http://127.0.0.1:59999",
          authenticationTemplate: [
            {
              slug: "apiKey",
              type: "apiKey",
              headers: { authorization: ["Bearer ", { type: "variable", name: "token" }] },
            },
          ],
        },
      });
      yield* adminApi.connections.create({
        payload: {
          owner: "org",
          name: connection,
          integration,
          template: TEMPLATE_API_KEY,
          identityLabel: "shared key",
          value: "sk-shared",
        },
      });

      // Two groups, one member each, through the admin plane.
      const [financeSubject, execSubject] = yield* Effect.promise(() =>
        Promise.all([subjectOf(call, finance!), subjectOf(call, exec!)]),
      );
      const [financeGroup, execsGroup] = yield* Effect.promise(() =>
        Promise.all(
          [financeName, execsName].map((name) =>
            call<{ readonly id: string }>("/api/admin/access-groups", {
              method: "POST",
              body: { name },
            }),
          ),
        ),
      );
      groupIds.push(financeGroup!.id, execsGroup!.id);
      yield* Effect.promise(() =>
        Promise.all([
          call(`/api/admin/access-groups/${financeGroup!.id}/members`, {
            method: "POST",
            body: { subject: financeSubject },
          }),
          call(`/api/admin/access-groups/${execsGroup!.id}/members`, {
            method: "POST",
            body: { subject: execSubject },
          }),
        ]),
      );

      // Before any restriction: an org connection is visible to every member.
      expect(yield* seesConnection(outsiderApi), "unrestricted: outsider sees it").toBe(true);

      yield* browser.session(admin, async ({ page, step }) => {
        await step("Open Access groups and restrict the connection to both groups", async () => {
          await visit(page, "/access-groups");
          await page.getByRole("button", { name: "Restrict connection" }).click();
          const dialog = page.getByRole("dialog", { name: "Restrict a connection" });
          await dialog.getByRole("combobox").click();
          await page.getByRole("option", { name: `${integration}/${connection}` }).click();
          await dialog.getByRole("checkbox", { name: financeName }).check();
          await dialog.getByRole("checkbox", { name: execsName }).check();
          await dialog.getByRole("button", { name: "Restrict" }).click();
          await page.getByText("Connection restricted", { exact: true }).waitFor();
        });

        await step("The restricted row lists both groups", async () => {
          const restricted = page.locator("section").filter({ hasText: "Restricted connections" });
          const line = restricted
            .locator("div")
            .filter({ hasText: `${integration}/${connection}` })
            .first();
          await line.getByText(financeName, { exact: true }).waitFor();
          await line.getByText(execsName, { exact: true }).waitFor();
        });

        await step("Members of either group keep access; an outsider loses it", async () => {
          expect(await Effect.runPromise(seesConnection(financeApi)), "finance member").toBe(true);
          expect(await Effect.runPromise(seesConnection(execApi)), "execs member").toBe(true);
          expect(await Effect.runPromise(seesConnection(outsiderApi)), "outsider").toBe(false);
          expect(
            await Effect.runPromise(seesConnection(adminApi)),
            "admin's own runtime view",
          ).toBe(false);
        });

        await step("Edit the grant set down to execs only", async () => {
          const restricted = page.locator("section").filter({ hasText: "Restricted connections" });
          await restricted
            .locator("div")
            .filter({ hasText: `${integration}/${connection}` })
            .getByRole("button", { name: "Edit" })
            .first()
            .click();
          const dialog = page.getByRole("dialog", { name: "Edit connection groups" });
          await dialog.getByRole("checkbox", { name: financeName }).uncheck();
          await dialog.getByRole("button", { name: "Save" }).click();
          await page.getByText("Connection groups updated", { exact: true }).waitFor();
        });

        await step("The change applies to open sessions at once", async () => {
          expect(await Effect.runPromise(seesConnection(financeApi)), "finance revoked").toBe(
            false,
          );
          expect(await Effect.runPromise(seesConnection(execApi)), "execs kept").toBe(true);
        });

        await step("Persisted server-side with exactly the remaining group", async () => {
          const body = await call<{
            readonly restrictions: readonly {
              readonly integration: string;
              readonly name: string;
              readonly groups: readonly string[];
            }[];
          }>("/api/admin/access-group-restrictions");
          const mine = body.restrictions.find(
            (r) => r.integration === String(integration) && r.name === String(connection),
          );
          expect(mine?.groups, "one grant row remains").toEqual([execsGroup!.id]);
        });
      });
    }).pipe(Effect.ensuring(cleanup));
  }),
);
