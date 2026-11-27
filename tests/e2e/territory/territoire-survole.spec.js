import { expect, test } from "@playwright/test";
import { configureAppTest, dismissStartupOverlay, waitForMapLoaded } from "../app-helpers";

const square = (x0, y0, x1, y1) => ({
  type: "Polygon",
  coordinates: [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]],
});

// Deux communes de part et d'autre de la longitude 6,47 ; la seconde est dans l'aire d'adhésion d'un parc national
const LIGHT = {
  type: "FeatureCollection",
  features: [
    { type: "Feature", id: "commune.1", properties: { cleabs: "C1", nom_officiel: "Les Vigneaux", code_insee: "05181", code_insee_du_departement: "05", population: 550 }, geometry: square(6.0, 44.5, 6.47, 45.5) },
    { type: "Feature", id: "commune.2", properties: { cleabs: "C2", nom_officiel: "Vallouise-Pelvoux", code_insee: "05101", code_insee_du_departement: "05", population: 1138 }, geometry: square(6.47, 44.5, 7.0, 45.5) },
    { type: "Feature", id: "parc_ou_reserve.1", properties: { cleabs: "P1", nature: "Parc national", toponyme: "Aire d'Adhésion du Parc National des Écrins" }, geometry: square(6.47, 44.5, 7.0, 45.5) },
  ],
};

async function setup(page, { lat, lng, zoom }) {
  await configureAppTest(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(({ lat, lng, zoom }) => {
    localStorage.setItem("lastMapLat", String(lat));
    localStorage.setItem("lastMapLng", String(lng));
    localStorage.setItem("lastMapZoom", String(zoom));
  }, { lat, lng, zoom });

  const requests = { light: 0, heavy: 0, weather: 0 };
  await page.route("https://data.geopf.fr/wfs/ows**", async (route) => {
    const url = decodeURIComponent(route.request().url());
    if (url.includes("BDCARTO_V5:commune")) {
      requests.light += 1;
      await route.fulfill({ contentType: "application/json", body: JSON.stringify(LIGHT) });
      return;
    }
    if (url.includes("BDTOPO_V3:foret_publique") && url.includes("BBOX(geometrie")) {
      requests.heavy += 1;
    }
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ type: "FeatureCollection", features: [] }) });
  });
  await page.route("https://api.open-meteo.com/**", async (route) => {
    requests.weather += 1;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ current: { temperature_2m: 18.2, weather_code: 0, is_day: 1 }, daily: { temperature_2m_max: [21], temperature_2m_min: [9] } }),
    });
  });

  await page.goto("/");
  await waitForMapLoaded(page);
  await dismissStartupOverlay(page);
  return requests;
}

test.describe("Territoire survolé", () => {
  test("affiche la commune puis le parc national en déplaçant la carte, sans nouvelle requête", async ({ page }) => {
    const requests = await setup(page, { lat: 44.87, lng: 6.455, zoom: 13 });
    const peek = page.locator("#territoryPeek");

    await expect(peek).toBeVisible();
    await expect(peek.locator(".territoryPeekTitle")).toHaveText("Les Vigneaux");
    await expect(peek.locator(".territoryPeekSubtitle")).toHaveText("Hautes-Alpes (05)");
    await expect(peek.locator(".territoryPeekWeather")).toContainText("18°");
    expect(requests.light).toBe(1);
    expect(requests.heavy).toBe(1);
    expect(requests.weather).toBe(1);

    // la carte glisse vers l'est (même dalle) : calcul local uniquement
    const map = page.locator("#map canvas").first();
    const box = await map.boundingBox();
    const y = box.y + box.height / 2;
    await page.mouse.move(box.x + box.width / 2 + 120, y);
    await page.mouse.down();
    for (let i = 1; i <= 12; i++) {
      await page.mouse.move(box.x + box.width / 2 + 120 - i * 20, y);
    }
    await page.mouse.up();

    await expect(peek.locator(".territoryPeekTitle")).toHaveText("Parc national des Écrins");
    await expect(peek.locator(".territoryPeekSubtitle")).toHaveText("Aire d'adhésion · Vallouise-Pelvoux (05)");
    expect(requests.light).toBe(1);
    expect(requests.heavy).toBe(1);

    // les boutons de la carte sont au-dessus du volet
    const peekBox = await peek.boundingBox();
    const geolocBox = await page.locator("#geolocateBtn").boundingBox();
    expect(geolocBox.y + geolocBox.height).toBeLessThanOrEqual(peekBox.y);

    // ouverture de l'espace de découverte avec le même titre
    await peek.locator("#territoryPeekOpen").click();
    await expect(page.locator("#territoryWindow .territoryTitle")).toHaveText("Parc national des Écrins");
    await expect(page.locator("#territoryWindow .territorySubtitle")).toContainText("Vallouise-Pelvoux · Hautes-Alpes");
    await expect(peek).toBeHidden();
    // commune et météo déjà connues : pas redemandées
    expect(requests.weather).toBe(1);
  });

  test("invite à zoomer quand la carte est trop éloignée", async ({ page }) => {
    const requests = await setup(page, { lat: 46.5, lng: 2.5, zoom: 6 });
    const peek = page.locator("#territoryPeek");
    await expect(peek).toBeVisible();
    await expect(peek.locator(".territoryPeekGuidance")).toHaveText("Vous êtes trop éloigné, zoomez pour découvrir");
    await expect(peek.locator("#territoryPeekOpen")).toBeDisabled();
    expect(requests.light).toBe(0);
  });

  test("peut être masqué", async ({ page }) => {
    await setup(page, { lat: 44.87, lng: 6.455, zoom: 13 });
    const peek = page.locator("#territoryPeek");
    await expect(peek.locator(".territoryPeekTitle")).toHaveText("Les Vigneaux");
    await peek.locator("#territoryPeekClose").click();
    await expect(peek).toBeHidden();
  });
});
