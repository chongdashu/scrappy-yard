import { describe, expect, it } from "vitest";
import { checkMenuEntries, esc, extraPopupId, menuEntryMarkup, removeRestart, type MenuEntry } from "../src/ui/menu-extra";

const about: MenuEntry = { id: "about", label: "About", body: "<p>Made <b>here</b></p>" };

describe("menu extras (GameModule.menu.extra)", () => {
  it("escapes plain text, each special character to its own entity", () => {
    expect(esc(`a < b > c & "d" 'e'`)).toBe("a &lt; b &gt; c &amp; &quot;d&quot; &#39;e&#39;");
    expect(esc("plain")).toBe("plain");
  });

  it("builds a menu button, a standard popup and, only with `pause`, a pause-card button", () => {
    const m = menuEntryMarkup(about);
    expect(m.menuButton).toBe('<button class="mbtn" data-act="extra:about" data-stagger>About</button>');
    expect(m.pauseButton).toBe("");
    expect(m.popup).toContain(`id="${extraPopupId("about")}" class="popup extra-pop"`);
    expect(m.popup).toContain('aria-labelledby="extra-about-title"');
    expect(m.popup).toContain('<div class="extra-body"><p>Made <b>here</b></p></div>'); // the body is the game's markup, as is
    expect(m.popup).toContain('<button class="btn primary" data-close data-autofocus>Close</button>');
    expect(m.popup.indexOf("hidden>")).toBeGreaterThan(0);
    expect(menuEntryMarkup({ ...about, pause: true }).pauseButton).toBe('<button class="btn" data-extra="about" id="pause-extra-about" data-stagger>About</button>');
  });

  it("escapes the label, title and close text, and uses the label as the title by default", () => {
    const m = menuEntryMarkup({ id: "credits", label: "Q&A <1>", title: 'Say "hi"', body: "", close: "Done >" });
    expect(m.menuButton).toContain(">Q&amp;A &lt;1&gt;</button>");
    expect(m.popup).toContain('id="extra-credits-title">Say &quot;hi&quot;</div>');
    expect(m.popup).toContain(">Done &gt;</button>");
    expect(menuEntryMarkup(about).popup).toContain('id="extra-about-title">About</div>');
  });

  it("accepts slugs used once, rejects anything that would break an id or a selector", () => {
    expect(() => checkMenuEntries([about, { ...about, id: "credits-2" }])).not.toThrow();
    expect(() => checkMenuEntries([about, about])).toThrow(/"about" is used twice/);
    for (const id of ["About", "1st", "a b", 'x"y', "", "-a"]) expect(() => checkMenuEntries([{ ...about, id }])).toThrow(/must match/);
    expect(() => checkMenuEntries([{ ...about, label: " " }])).toThrow(/needs a label/);
    expect(() => checkMenuEntries([{ ...about, body: undefined as unknown as string }])).toThrow(/needs a body/);
  });

  it("makes an entry with an href a menu link: no popup, no pause-card entry, the URL escaped", () => {
    const scene: MenuEntry = { id: "props", label: "Props <scene>", href: '?scene=props&x="1"' };
    const m = menuEntryMarkup(scene);
    expect(m.menuButton).toBe('<a class="mbtn" href="?scene=props&amp;x=&quot;1&quot;" data-extra-link="props" data-stagger>Props &lt;scene&gt;</a>');
    expect([m.pauseButton, m.popup]).toEqual(["", ""]);
    expect(() => checkMenuEntries([about, scene])).not.toThrow();
    expect(() => checkMenuEntries([{ ...scene, href: " " }])).toThrow(/href must be a URL/);
    expect(() => checkMenuEntries([{ ...scene, body: "<p>x</p>" }])).toThrow(/not both/);
    expect(() => checkMenuEntries([{ ...scene, pause: true }])).toThrow(/menu-only/);
  });
});

describe("pause card options (GameModule.pause)", () => {
  it("restart: false hides Restart round and marks the page, so the smoke check expects it gone", () => {
    const button = { hidden: false };
    const doc = { querySelector: (sel: string) => (sel === "#pause-restart" ? button : null), body: { dataset: {} as Record<string, string> } };
    removeRestart(doc as unknown as Document);
    expect(button.hidden).toBe(true);
    expect(doc.body.dataset.restart).toBe("off");
  });
});
