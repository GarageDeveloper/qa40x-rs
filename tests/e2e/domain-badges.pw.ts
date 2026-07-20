/**
 * INVARIANT FAMILY E — domain badges tell the truth (#52), ported to v2.
 *
 * The FFT budget is display-derived: a spectrum is computed only for traces
 * some spectrum TILE actually shows. Pinned here:
 *
 *   - a trace on no fd tile has a dimmed FD badge whose tooltip STATES the
 *     display rule (not an unexplained gap);
 *   - with no fd tile at all, Input L and Input R are EXACTLY symmetric —
 *     no channel is favoured;
 *   - putting a trace on an fd tile lights its FD badge, and the tooltip is
 *     truthful in both states.
 */
import { expect, test } from "./adapter/fixtures";

const IN_R = "hw-in-right";

async function badgesOf(
  app: import("./adapter/app").AppV2,
  id: string
): Promise<{ tag: string; dim: boolean; tip: string }[]> {
  const rows = await app.poolRows();
  return rows.find((r) => r.id === id)?.badges ?? [];
}

test("FD badges follow the display rule, symmetrically, with truthful tooltips", async ({
  app,
}) => {
  await app.waitConnected();
  // One visible tile only: the boot 2×2 has TWO spectrum tiles showing
  // Input L, which would keep its FD lit through the kind switch below.
  await app.setLayoutPattern("1");
  const id = await app.addSine();
  await app.playSine(id);

  // Frames flow: both channels carry scope (td) data…
  await expect
    .poll(async () => (await badgesOf(app, "hw-in-left")).some((b) => b.tag === "TD"), {
      timeout: 10_000,
    })
    .toBe(true);
  await expect
    .poll(async () => (await badgesOf(app, IN_R)).some((b) => b.tag === "TD"), {
      timeout: 10_000,
    })
    .toBe(true);

  // …and the displayed channel (Input L is on the spectrum tile) gets its
  // spectrum, while the undisplayed one gets a dimmed badge that SAYS WHY.
  await expect
    .poll(
      async () =>
        (await badgesOf(app, "hw-in-left")).find((b) => b.tag === "FD" && !b.dim)?.tip,
      { timeout: 10_000 }
    )
    .toContain("Frequency-domain frame");
  const rFd = (await badgesOf(app, IN_R)).find((b) => b.tag === "FD");
  expect(rFd?.dim).toBe(true);
  expect(rFd?.tip).toContain("no frequency-domain graph shows this trace");

  // Turn the tile into a Scope: now NO fd tile shows anything. Input L must
  // drop to exactly Input R's state — same badges, same tooltips. Any
  // asymmetry here is an arbitrary fallback (#52).
  await app.setTileKind("scope");
  await expect
    .poll(
      async () =>
        (await badgesOf(app, "hw-in-left")).find((b) => b.tag === "FD")?.dim ?? null,
      { timeout: 10_000 }
    )
    .toBe(true);
  expect(await badgesOf(app, "hw-in-left")).toEqual(await badgesOf(app, IN_R));

  // Back to a Spectrum (Input L kept as its series): its FD lights again;
  // Input R stays dimmed.
  await app.setTileKind("spectrum");
  await expect
    .poll(
      async () =>
        (await badgesOf(app, "hw-in-left")).find((b) => b.tag === "FD")?.dim ?? null,
      { timeout: 10_000 }
    )
    .toBe(false);
  expect((await badgesOf(app, IN_R)).find((b) => b.tag === "FD")?.dim).toBe(true);

  // And the cure the dimmed tooltip prescribes actually works: show Input R
  // on the fd tile → its FD badge lights.
  await app.setTraceVisible(IN_R, true);
  await expect
    .poll(
      async () =>
        (await badgesOf(app, IN_R)).find((b) => b.tag === "FD")?.dim ?? null,
      { timeout: 10_000 }
    )
    .toBe(false);
  expect((await badgesOf(app, IN_R)).find((b) => b.tag === "FD")?.tip).toContain(
    "Frequency-domain frame"
  );
});
