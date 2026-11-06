# Generates index.html + verbs.html for the Scrappy Yard gameplay trailer (40 s, 1920x1080@30).
# Event times come from the capture per.json logs (frame i = i/30 s of the clip).
import json, os, sys
FR = os.environ.get("FRAMES", "/workspace/sy-gameplay/frames")
DUR = 40.0
def events(n):
    p = json.load(open(f"{FR}/{n}/per.json")); ev = []
    for i in range(1, len(p)):
        a, b = p[i-1], p[i]; t = i / 30
        if b[0] > a[0]: ev.append((t, "nut"))
        if b[1] > a[1]: ev.append((t, "stumble"))
        if a[3] and not b[3]: ev.append((t, "jump"))
        if not a[3] and b[3]: ev.append((t, "land"))
        if b[4] != a[4] and b[4] == 3: ev.append((t, "lose"))
    return ev
C = json.load(open(os.path.join(os.path.dirname(__file__), "cut.json")))
shots = C["shots"]  # [id, src, start, end, media_in, punch?]
V, A, sfx = [], [], []
for i, (id, src, s, e, m, *rest) in enumerate(shots):
    V.append(f'''      <div id="w-{id}" class="vwrap">
        <video id="v-{id}" class="clip" src="assets/footage/{src}.mp4" muted playsinline data-start="{s:.2f}" data-duration="{e-s:.2f}" data-media-start="{m:.2f}" data-track-index="{i%2}"></video>
      </div>''')
    try: ev = events(src)
    except FileNotFoundError: ev = []
    last = -9
    for t, k in ev:
        if not (m <= t < m + (e - s) - 0.05): continue
        T = s + (t - m)
        if k == "nut":
            if T - last < 0.22: continue
            last = T; sfx.append(("pickup", T, 0.42))
        elif k == "jump": sfx.append(("jump", T, 0.7))
        elif k == "land":
            if any(f == "jump" and 0 < T - tt < 1.2 for f, tt, _ in sfx): sfx.append(("land", T, 0.5))
        elif k == "stumble": sfx.append(("hit", T, 0.75))
        elif k == "lose": sfx += [("hit", T, 0.9), ("gameover", T + 0.08, 0.85)]
sfx += [tuple(x) for x in C["sfx_extra"]]
sfx.sort(key=lambda x: x[1])
LEN = {"stomp": 0.8, "danger": 0.8, "gameover": 2.5, "ui_start": 1.2, "hit": 0.7}
A.append(f'      <audio id="a-bgm" src="assets/audio/bgm_play.mp3" data-start="0" data-duration="{DUR}" data-media-start="38.435" data-volume="0.62" data-fade-out="1.6" data-track-index="8"></audio>')
for i, (f, t, v) in enumerate(sfx):
    A.append(f'      <audio id="a-{f}-{i}" src="assets/audio/sfx_{f}.mp3" data-start="{t:.2f}" data-duration="{LEN.get(f,0.5)}" data-volume="{v}" data-track-index="{9+i%3}"></audio>')
S = [f'      <div id="{n}" class="scene clip" data-composition-id="{n}" data-composition-src="compositions/{n}.html" data-start="{s}" data-duration="{d}" data-track-index="{3+k}" data-track-kind="graphics"></div>' for k, (n, s, d) in enumerate(C["scenes"])]
punch = "\n".join(f'      tl.fromTo("#w-{id}", {{ scale: 1.1 }}, {{ scale: 1, duration: 0.3, ease: "power3.out" }}, {s});' for (id, src, s, e, m, *r) in shots if r and r[0] == "punch")
push = "\n".join(f'      tl.fromTo("#w-{id}", {{ scale: 1 }}, {{ scale: {r[1]}, duration: {e-s:.2f}, ease: "none" }}, {s});' for (id, src, s, e, m, *r) in shots if r and r[0] == "push")
hits = "\n".join(f'      tl.to("#w-{id}", {{ scale: 1.12, duration: 0.07, ease: "power4.out" }}, {t-0.02:.2f});\n      tl.to("#w-{id}", {{ scale: 1.02, duration: 0.5, ease: "power2.out" }}, {t+0.05:.2f});' for id, t in C["hits"])
html = f'''<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=1920, height=1080" />
    <script src="https://cdn.jsdelivr.net/npm/gsap@3.15.0/dist/gsap.min.js"></script>
    <style>
      * {{ margin: 0; padding: 0; box-sizing: border-box; }}
      html, body {{ margin: 0; width: 1920px; height: 1080px; overflow: hidden; background: #16110F; }}
      #root {{ position: relative; width: 1920px; height: 1080px; overflow: hidden; background: #16110F; }}
      .vwrap {{ position: absolute; inset: 0; transform-origin: 50% 50%; z-index: 1; }}
      .vwrap video {{ position: absolute; inset: 0; width: 1920px; height: 1080px; object-fit: cover; }}
      .scene {{ position: absolute; inset: 0; z-index: 5; }}
    </style>
  </head>
  <body>
    <div id="root" data-composition-id="main" data-start="0" data-duration="{DUR}" data-width="1920" data-height="1080">
{chr(10).join(V)}
{chr(10).join(S)}
{chr(10).join(A)}
    </div>
    <script>
      window.__timelines = window.__timelines || {{}};
      const tl = gsap.timeline({{ paused: true }});
      tl.set([{", ".join(f'"#w-{id}"' for id, t in C["hits"])}], {{ scale: 1 }}, 0);
{hits}
{push}
{punch}
      window.__timelines["main"] = tl;
    </script>
  </body>
</html>
'''
open(os.path.join(os.path.dirname(__file__), "..", "index.html"), "w").write(html)
# verbs.html: words land on real events (times relative to the verbs scene start)
vs = C["verbs"]  # {"start":5.6,"dur":7.2,"words":[[id,text,t,hold,sub]]}
W, T = [], []
for k, (id, text, t, hold, sub) in enumerate(vs["words"]):
    W.append(f'    <div id="v-{id}" class="v-word clip" data-start="{t:.2f}" data-duration="{hold:.2f}" data-track-index="{1+2*k}">{text}</div>')
    T.append(f'    slam("#v-{id}", {t:.2f}); tl.to("#v-{id}", {{ opacity: 0, filter: "blur(8px)", duration: 0.12, ease: "power3.in" }}, {t+hold-0.14:.2f});')
    if sub:
        W.append(f'    <div id="v-{id}sub" class="v-sub clip" data-start="{t+0.3:.2f}" data-duration="{hold-0.3:.2f}" data-track-index="{2+2*k}">{sub}</div>')
        T.append(f'    blurIn("#v-{id}sub", {t+0.3:.2f}); tl.to("#v-{id}sub", {{ opacity: 0, duration: 0.12, ease: "power3.in" }}, {t+hold-0.14:.2f});')
verbs = f'''<template>
  <style>
    #root {{ position: absolute; inset: 0; overflow: hidden; }}
    .v-word {{ position: absolute; left: 120px; top: 840px; font-family: "Archivo Black", sans-serif; text-transform: uppercase;
      font-size: 150px; line-height: 0.9; color: #fff; text-shadow: 7px 7px 0 #16110F; white-space: nowrap; }}
    #v-collect {{ color: #FFB000; }}
    .v-sub {{ position: absolute; left: 128px; top: 784px; font-family: "Oswald", sans-serif; font-weight: 600; font-size: 44px;
      letter-spacing: 0.04em; text-transform: uppercase; color: #fff; text-shadow: 4px 4px 0 #16110F; }}
  </style>
  <div id="root" data-composition-id="verbs" data-width="1920" data-height="1080" data-layout-allow-overflow>
{chr(10).join(W)}
  </div>
  <script>
    const tl = gsap.timeline({{ paused: true }});
    const slam = (sel, at) => tl.fromTo(sel, {{ scale: 1.35, opacity: 0, filter: "blur(10px)" }}, {{ scale: 1, opacity: 1, filter: "blur(0px)", duration: 0.2, ease: "expo.out", transformOrigin: "0% 100%" }}, at);
    const blurIn = (sel, at) => tl.fromTo(sel, {{ opacity: 0, filter: "blur(8px)" }}, {{ opacity: 1, filter: "blur(0px)", duration: 0.16, ease: "power4.out" }}, at);
{chr(10).join(T)}
    window.__timelines["verbs"] = tl;
  </script>
</template>
'''
open(os.path.join(os.path.dirname(__file__), "..", "compositions", "verbs.html"), "w").write(verbs)
print("shots", len(shots), "sfx", len(sfx))
