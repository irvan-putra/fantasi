# Pramuka Astral score

`compose.py` renders `score.ogg` / `score.m4a` (60 s seamless loop, 96 BPM, D dorian). Run `python3 compose.py` with numpy and scipy, then encode with ffmpeg.

- Original composition: chord progression, arpeggio and bell phrases are hand-written note data. No existing melody is quoted.
- Written by an AI (Claude, through Instinct) for Irvan Putra. Not listened to by the author before release: a phone test by Irvan is the real check.
- Method credit: the synthesis approach (plucked and bell voices, detuned pads, filtered-noise percussion, loop folded over its reverb tail, RMS normalise plus limiter) follows the score kit of [cth9191/animate](https://github.com/cth9191/animate) (MIT, copyright (c) 2026 cth9191), through Irvan's fork [irvan-putra/animate](https://github.com/irvan-putra/animate). No code is copied verbatim; the MIT notice is kept here for the idea and structure borrowed.
- Voiced between 150 and 1500 Hz on purpose, because phone speakers lose everything below about 150 Hz.
