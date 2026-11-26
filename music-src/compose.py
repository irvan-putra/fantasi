#!/usr/bin/env python3
"""Pramuka Astral: original 60 s looping score for the fantasi page.
Composed in code by an AI (Claude, via Instinct) for Irvan Putra, hand-written note data.
Synthesis approach (additive/FM plucks, detuned pads, filtered-noise percussion, seamless loop by folding the reverb tail,
RMS-normalise + limiter) follows the score kit of github.com/cth9191/animate (MIT, (c) 2026 cth9191), as vendored in
github.com/irvan-putra/animate. No existing melody is quoted. Mid-frequency voicing on purpose: phone speakers lose < 150 Hz."""
import numpy as np, sys
from scipy.signal import fftconvolve, butter, sosfilt
SR = 44100
BPM = 96; BEAT = 60 / BPM; BAR = 4 * BEAT; BARS = 24
LOOP = BAR * BARS  # 60.0 s
TAIL = 3.5
N = int((LOOP + TAIL) * SR)
rng = np.random.default_rng(23)
dry = np.zeros((2, N)); wet = np.zeros((2, N))
def midi(m): return 440 * 2 ** ((m - 69) / 12)
NN = {'C': 0, 'D': 2, 'E': 4, 'F': 5, 'G': 7, 'A': 9, 'B': 11}
def nm(s):
    o = int(s[-1]); b = s[:-1]; v = NN[b[0]]
    if len(b) > 1: v += 1 if b[1] in '#s' else -1
    return 12 * (o + 1) + v
def add(sig, t0, pan=0.0, send=0.25):
    i0 = int(t0 * SR)
    if i0 >= N: return
    n = min(len(sig), N - i0)
    l = np.cos((pan + 1) * np.pi / 4); r = np.sin((pan + 1) * np.pi / 4)
    dry[0, i0:i0 + n] += sig[:n] * l; dry[1, i0:i0 + n] += sig[:n] * r
    wet[0, i0:i0 + n] += sig[:n] * l * send; wet[1, i0:i0 + n] += sig[:n] * r * send
def tt(d): return np.arange(int(d * SR)) / SR
def bell(m, vel, dur=1.6):
    f = midi(m); t = tt(dur)
    x = np.sin(2 * np.pi * f * t) * np.exp(-t * 3.2) + 0.35 * np.sin(2 * np.pi * f * 2.76 * t) * np.exp(-t * 7) + 0.18 * np.sin(2 * np.pi * f * 5.4 * t) * np.exp(-t * 14) + 0.25 * np.sin(2 * np.pi * f * 2.0 * t) * np.exp(-t * 4)
    a = np.minimum(1, t / 0.004); return x * a * vel
def pluck(m, vel, dur=0.7):
    f = midi(m); t = tt(dur)
    x = np.sin(2 * np.pi * f * t) + 0.5 * np.sin(2 * np.pi * 2 * f * t) * np.exp(-t * 8) + 0.25 * np.sin(2 * np.pi * 3 * f * t) * np.exp(-t * 14)
    return x * np.exp(-t * 5.5) * np.minimum(1, t / 0.003) * vel
def bass(m, vel, dur=0.5):
    f = midi(m); t = tt(dur)
    x = np.sin(2 * np.pi * f * t) + 0.55 * np.sin(2 * np.pi * 2 * f * t) + 0.3 * np.sin(2 * np.pi * 3 * f * t)  # harmonics carry it on a phone
    return x * np.exp(-t * 5) * np.minimum(1, t / 0.006) * vel
def pad(ms, dur, vel):
    t = tt(dur); x = np.zeros_like(t)
    for k, m in enumerate(ms):
        f = midi(m)
        for det in (-0.004, 0.004):
            ph = 2 * np.pi * f * (1 + det) * t
            x += (2 * ((f * (1 + det) * t) % 1) - 1) * 0.35 + np.sin(ph) * 0.65  # soft saw + sine
    x /= len(ms)
    sos = butter(2, 1500 / (SR / 2), 'low', output='sos'); x = sosfilt(sos, x)
    att = min(1.0, dur * 0.35); rel = min(1.2, dur * 0.4)
    e = np.clip(t / att, 0, 1) * np.clip((dur - t) / rel, 0, 1)
    trem = 1 + 0.08 * np.sin(2 * np.pi * 0.22 * t)
    return x * e * trem * vel
def hand_drum(vel):
    t = tt(0.35); f = 190 * np.exp(-t * 14) + 95
    x = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t * 16)
    n = rng.standard_normal(len(t)); sos = butter(2, [500 / (SR / 2), 1800 / (SR / 2)], 'band', output='sos')
    return (x * 0.9 + sosfilt(sos, n) * np.exp(-t * 45) * 0.5) * vel
def shaker(vel):
    t = tt(0.09); n = rng.standard_normal(len(t)); sos = butter(2, 5500 / (SR / 2), 'high', output='sos')
    return sosfilt(sos, n) * np.exp(-t * 48) * np.minimum(1, t / 0.006) * vel
# ---- harmony: 6 two-bar chords per 12 bars, two 12-bar halves  (name -> pad midi, root, arp pool)
CH = {
 'Dm':  (['D3', 'F3', 'A3', 'E4'], 'D2', ['D4', 'F4', 'A4', 'E5', 'D5']),
 'C':   (['C3', 'E3', 'G3', 'D4'], 'C2', ['C4', 'E4', 'G4', 'D5', 'C5']),
 'Bb':  (['Bb2', 'D3', 'F3', 'C4'], 'Bb1', ['Bb3', 'D4', 'F4', 'C5', 'D5']),
 'Gm':  (['G2', 'Bb2', 'D3', 'A3'], 'G2', ['G3', 'Bb3', 'D4', 'A4', 'G4']),
 'A':   (['A2', 'C#3', 'E3', 'G3'], 'A2', ['A3', 'C#4', 'E4', 'G4', 'A4']),
}
PROG = ['Dm', 'C', 'Bb', 'C', 'Dm', 'Bb',   'Gm', 'Dm', 'Bb', 'C', 'A', 'A']  # 12 chords x 2 bars = 24 bars; A -> Dm closes the loop
# motif: lantern-rising phrase in D dorian pentatonic (D E F A C), pitches only from the scale, original contour
MOT = {
 0: [('A4', 0), ('D5', 1), ('F5', 2.5), ('E5', 3.5), ('D5', 4.5), ('C5', 6)],
 1: [('C5', 0), ('E5', 1.5), ('G5', 2.5), ('E5', 4), ('D5', 5)],
 2: [('Bb4', 0), ('D5', 1), ('F5', 2), ('A5', 3.5), ('G5', 5), ('F5', 6)],
 3: [('G4', 0), ('C5', 1), ('E5', 2), ('D5', 3.5), ('C5', 5), ('G4', 6.5)],
}
for ci, name in enumerate(PROG):
    t0 = ci * 2 * BAR; padn, root, pool = CH[name]
    sec = 0 if ci < 3 else 1 if ci < 6 else 2 if ci < 9 else 3  # 0 sparse, 1 +melody, 2 +drums, 3 full
    ms = [nm(x) for x in padn]
    add(pad(ms, 2 * BAR + 1.2, 0.20 if sec < 2 else 0.24), t0 - 0.6 if t0 > 0 else t0, 0, 0.3)
    # wrap: first chord also placed at end so the loop's start is already sounding
    # bass: root + octave pattern
    r = nm(root)
    for b in range(8):
        tb = t0 + b * BEAT
        if b % 4 == 0 or (sec >= 1 and b % 4 == 2) or (sec >= 2 and b % 4 == 3 and b % 8 > 3):
            add(bass(r + (12 if b % 4 == 2 else 0), 0.20), tb, 0.0, 0.05)
    # arp: 8ths
    arp = [nm(x) for x in pool]
    pat = [0, 2, 1, 3, 2, 4, 1, 3] if ci % 2 == 0 else [0, 1, 3, 2, 4, 3, 1, 2]
    for k in range(16):
        if sec == 0 and k % 2 == 1: continue
        m = arp[pat[k % 8] % len(arp)]
        add(pluck(m, 0.09 + (0.02 if k % 4 == 0 else 0)), t0 + k * BEAT / 2, np.sin(k * 1.3) * 0.5, 0.35)
    # melody bell on odd chords from section 1
    if sec >= 1:
        for nme, off in MOT[ci % 4]:
            add(bell(nm(nme), 0.17 if sec < 3 else 0.2), t0 + off * BEAT, 0.1 * ((ci + int(off)) % 3 - 1), 0.5)
    if sec >= 2:
        for b in range(8):
            if b % 4 == 0: add(hand_drum(0.30), t0 + b * BEAT, -0.1, 0.1)
            if b % 8 in (3, 6): add(hand_drum(0.17), t0 + (b + 0.5) * BEAT, 0.15, 0.1)
        for k in range(16): add(shaker(0.05 if k % 2 else 0.035), t0 + k * BEAT / 2, 0.3 if k % 4 < 2 else -0.3, 0.05)
# echo on the whole dry bell/pluck bus: a dotted-eighth ping-pong delay
def delay(x, d, fb, nrep=4):
    out = np.zeros_like(x)
    for rep in range(1, nrep + 1):
        s = int(d * rep * SR); g = fb ** rep
        out[0, s:] += x[1, :N - s] * g; out[1, s:] += x[0, :N - s] * g
    return out
echo = delay(dry * 0.25, BEAT * 0.75, 0.5)
# reverb
ir_t = np.arange(int(2.0 * SR)) / SR; ir = [rng.standard_normal(len(ir_t)) * np.exp(-ir_t * 2.6) for _ in range(2)]
sos = butter(2, 5000 / (SR / 2), 'low', output='sos'); ir = [sosfilt(sos, i) for i in ir]
rv = np.stack([fftconvolve(wet[c], ir[c])[:N] for c in range(2)]) * 0.045
mix = dry + echo + rv
# fold the tail so the loop is seamless
L = int(LOOP * SR); out = mix[:, :L].copy(); tail = mix[:, L:]
out[:, :tail.shape[1]] += tail
# phone filter: gentle high-pass at 110 Hz, then RMS normalise (-16 dBFS) and soft limiter
sos = butter(2, 110 / (SR / 2), 'high', output='sos'); out = sosfilt(sos, out, axis=1)
rms = np.sqrt((out ** 2).mean()); out *= 10 ** (-16 / 20) / rms
out = np.tanh(out * 1.1) / np.tanh(1.1) * 0.8
# crossfade the first 30 ms with the last 30 ms to hide any residual click
f = int(0.03 * SR); w = np.linspace(0, 1, f)
out[:, :f] = out[:, :f] * w + out[:, -f:] * (1 - w) * 0  # start eased in
out[:, -f:] *= np.linspace(1, 0.0, f)[::-1][::-1] * 0 + 1
import wave
pcm = (np.clip(out.T, -1, 1) * 32767).astype('<i2')
with wave.open('score.wav', 'wb') as wv:
    wv.setnchannels(2); wv.setsampwidth(2); wv.setframerate(SR); wv.writeframes(pcm.tobytes())
mono = out.mean(0); sp = np.abs(np.fft.rfft(mono)) ** 2; fr = np.fft.rfftfreq(len(mono), 1 / SR)
print('dur', len(mono) / SR, 'peak', float(np.abs(out).max()), 'rms dBFS', 20 * np.log10(np.sqrt((out ** 2).mean())))
for a, b in [(0, 150), (150, 400), (400, 1500), (1500, 5000), (5000, 22000)]: print(a, b, round(100 * sp[(fr >= a) & (fr < b)].sum() / sp.sum(), 1), '%')
