# Audio manifest — Scrapyard Dash

Generated with ElevenLabs (music_v2 force_instrumental; eleven_text_to_sound_v2, prompt_influence 0.6) on 2026-11-04 (menu BGM, UI pack, hit and game-over regenerated the same day for the scrapyard menu redesign: no cartoon squeak / sad trombone). Files: `game/public/assets/audio/`, masters copied to `share/media/audio/`. Wiring: `game/src/sfx.ts`, `game/src/game.ts`, tracks in `game/src/index.ts`. Missing/failed clips fall back to the old synth sounds.

| File | Duration (s) | Bytes | Trigger | Prompt |
|---|---|---|---|---|
| bgm_menu.mp3 | 55.04 | 1321004 | music track `menu` on title/menu phase | Instrumental junkyard adventure main menu theme for an action runner game, 110 BPM, gritty overdriven bass riff, heavy industrial metal percussion with anvil hits and clanking scrap, distorted synth stabs and bold brass, confident and tense, building anticipation, loopable, no vocals |
| bgm_play.mp3 | 85.03 | 2040812 | music track `play` on countdown/playing | Instrumental high-energy cartoon chase music, 150 BPM, industrial junkyard percussion with clanging metal, driving bass, brass stabs, building pressure, a giant robot is chasing, loopable, no vocals |
| sfx_ui_hover.mp3 | 0.52 | 8820 | AudioBus.ui.hover (menu cursor) | Short tight mechanical metal latch tick, industrial UI hover, crisp |
| sfx_ui_click.mp3 | 0.63 | 10492 | AudioBus.ui.press (buttons) | Chunky heavy industrial button press, thick steel lever clunk with pneumatic hiss, UI confirm |
| sfx_ui_back.mp3 | 0.63 | 10492 | AudioBus.ui.back | Short industrial UI cancel, heavy metal latch releasing with low clunk, descending |
| sfx_ui_start.mp3 | 1.41 | 23030 | AudioBus.ui.whoosh (Play/screen transition) | Powerful engine rev and heavy steel gate slam, junkyard game start, punchy industrial |
| sfx_jump.mp3 | 0.52 | 8820 | EV.jump | Cartoon springy jump boing, short and bouncy |
| sfx_land.mp3 | 0.52 | 8820 | EV.land (vol by impact) | Small cartoon character landing thud on dirt and scrap metal |
| sfx_pickup.mp3 | 0.52 | 8820 | EV.nut (pitch steps) | Bright cartoon collectible pickup, metal nut clink with sparkle chime |
| sfx_strafe.mp3 | 0.52 | 8820 | EV.lane (lane changed) | Subtle quick air whoosh swish sidestep |
| sfx_hit.mp3 | 1.04 | 17179 | EV.stumble; EV.lose crash | Hard heavy scrap metal car crash impact, crunching steel collision smash with debris rattle, realistic, no cartoon |
| sfx_fall.mp3 | 1.52 | 24702 | EV.lose reason=fall | Cartoon falling whistle descending into a pit |
| sfx_gameover.mp3 | 2.25 | 36405 | EV.lose (all) | Short dark industrial fail sting, deep metal slam and grinding machinery winding down to silence, ominous, no trombone, no cartoon |
| sfx_danger.mp3 | 0.84 | 13835 | pingLane hot stage (hazard <1.2s in your lane) | Short tense warning sting, alarm stab for near miss danger |
| sfx_stomp.mp3 | 0.84 | 13835 | timer while playing, louder/faster as mech gap shrinks | Heavy giant robot mech footstep stomp, metallic thud with hydraulic hiss |
| sfx_win.mp3 | 2.04 | 33061 | EV.win | Triumphant cartoon victory finish chime fanfare, short |
| sfx_retry.mp3 | 0.63 | 10492 | phase countdown after results/ending/paused | Quick cartoon rewind click restart sound |
