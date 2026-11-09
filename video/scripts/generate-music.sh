#!/usr/bin/env bash
# Synthesizes the royalty-free background bed for shorts with ffmpeg only (no samples, no downloads).
# 96 BPM, four-on-the-floor kick, off-beat hats, snare on 2 and 4, an eighth-note bass and arpeggio over
# Am - F - C - G. Eight bars (20 s) loop seamlessly: every component is periodic in the loop length and
# chords fade through zero at bar lines.
set -euo pipefail

OUTPUT="${1:?usage: generate-music.sh <output.mp3>}"
BEAT=0.625
EIGHTH=0.3125
BAR_SECONDS=2.5
LOOP_SECONDS=20
BAR="floor(mod(t,4*${BAR_SECONDS})/${BAR_SECONDS})"

# pick <Am> <F> <C> <G>: value of the current bar's chord.
pick() { echo "if(lt(${BAR},1),$1,if(lt(${BAR},2),$2,if(lt(${BAR},3),$3,$4)))"; }
ROOT=$(pick 110 87.31 130.81 98)
TONE1=$(pick 220 174.61 261.63 196)
TONE2=$(pick 261.63 220 329.63 246.94)
TONE3=$(pick 329.63 261.63 392 293.66)
STEP="mod(floor(t/${EIGHTH}),4)"
ARP="if(lt(${STEP},1),2*(${TONE1}),if(lt(${STEP},2),2*(${TONE2}),if(lt(${STEP},3),2*(${TONE3}),2*(${TONE2}))))"
PAD_ENV="(0.5-0.5*cos(2*PI*mod(t,${BAR_SECONDS})/${BAR_SECONDS}))"

KICK="0.8*sin(2*PI*(45*mod(t,${BEAT})+2.25*(1-exp(-40*mod(t,${BEAT})))))*exp(-9*mod(t,${BEAT}))"
HAT="0.12*(random(0)*2-1)*exp(-70*mod(t+${EIGHTH},${BEAT}))"
SNARE="0.2*(random(1)*2-1)*exp(-22*mod(t+${BEAT},2*${BEAT}))"
BASS="0.3*sin(2*PI*(${ROOT})*mod(t,${EIGHTH}))*exp(-5*mod(t,${EIGHTH}))"
PAD="0.05*${PAD_ENV}*(sin(2*PI*(${TONE1})*t)+sin(2*PI*(${TONE2})*t)+sin(2*PI*(${TONE3})*t))"
PLUCK="0.09*sin(2*PI*(${ARP})*mod(t,${EIGHTH}))*exp(-9*mod(t,${EIGHTH}))"

mkdir -p "$(dirname "${OUTPUT}")"
ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i "aevalsrc='${KICK}+${HAT}+${SNARE}+${BASS}+${PAD}+${PLUCK}':s=44100:d=${LOOP_SECONDS}" \
  -af "alimiter=limit=0.9" -ac 2 -c:a libmp3lame -b:a 128k "${OUTPUT}"
echo "Wrote ${OUTPUT}"
