# Scrappy Yard — gameplay-main trailer (SPEC)

GOAL:    mostly real play: a viewer sees runners strafe, jump, grab nuts and get run down by the junk mech,
         then opens wavedash.com/games/scrappy-yard (Wavedash play page). Roster beat shows six playable
         characters (raccoon + paid skins).
OUTPUT:  HyperFrames, 1920 x 1080, 30 fps, 40.0 s. Music bgm_play.mp3 from media 38.435 s (150 BPM, beat 0.4 s).
LOOK:    same as the 36 s trailer (../../project/SPEC.md): hazard yellow #F6C21A / black #16110F chevron tape,
         Archivo Black + Oswald, white type with hard offset shadow on footage, nut gold #FFB000 on one word.
         Type is smaller and rarer: ~33.6 s of 40 s is gameplay; only the end card is a full-frame card.
FOOTAGE: fresh Nov 5 headless captures of the current Scrappy Yard build (WebGL2 1280x720, HUD hidden, lanczos
         to 1080p): sy-intro, sy-run-long (15 s), sy-high-long, sy-mockd, sy-chase-long, sy-crash,
         plus skin b-roll sy-fox / sy-cat / sy-badger / sy-possum / sy-otter.
SHOTS:
  0.0-5.6   HOOK + TITLE: mech drops and slams (0.7 s, stomp + punch); SCRAPPY / YARD at 3.2/3.6, tape sweep 5.3-5.8.
  5.6-12.8  RUN: one continuous heads-up run with strafes. RUN (6.0), COLLECT on a real nut cluster (9.8),
            JUMP on a real jump (12.35, carries into the next shot's jump at 13.8).
  12.8-16.0 HIGH READ wide: crane, planes, jump.
  16.0-19.2 MOCKUP-D angle: car dodges, strafes, a jump at 18.83.
  19.2-22.4 ROSTER: 8 one-beat punches across raccoon + Scrap Fox / Alley Cat / Bandit Badger / Yard Possum /
            Junk Otter; overlay "PICK YOUR SCRAPPER".
  22.4-28.8 PRESSURE: low-chase cam, mech closing after real stumbles; DON'T / GET / CAUGHT.
  28.8-33.6 CRASH: real crash into a scrap car (30.27 s, hit + gameover sfx, punch), then the real BUSTED card.
  33.6-40.0 END CARD: SCRAPPY YARD wordmark, verbs line, CTA "PLAY ON WAVEDASH / wavedash.com/games/scrappy-yard".
BANNED:  as the 36 s trailer SPEC.
BUILD:   python3 tools/gen_index.py (tools/cut.json + /workspace/sy-gameplay/frames/*/per.json) -> index.html, compositions/verbs.html.
