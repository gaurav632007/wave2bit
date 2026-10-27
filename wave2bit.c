/* Wave2Bit — PCM Voice to Binary (C console version)
 *
 * Same pipeline as the website, but as a simple terminal program:
 *   Demo Signal -> Sampling -> Quantization -> PCM Encoding -> Noise
 *
 * Compile:  gcc wave2bit.c -o wave2bit -lm
 * Run:      ./wave2bit   (or wave2bit.exe on Windows)
 */

#include <stdio.h>
#include <stdlib.h>
#include <math.h>

#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

#define WAVE_POINTS 240   /* resolution of the demo signal */
#define TABLE_ROWS 10     /* encoding table rows shown */

/* Artificial voice-like signal: two sine waves + small amplitude variation. */
void make_demo_signal(double *sig, int n) {
    int i;
    double peak = 0.0;
    for (i = 0; i < n; i++) {
        double t = (double)i / n;
        double env = 0.6 + 0.4 * sin(2 * M_PI * 2 * t + 0.6);
        double v = sin(2 * M_PI * 5 * t) * 0.55
                 + sin(2 * M_PI * 11 * t + 1.1) * 0.28
                 + sin(2 * M_PI * 23 * t + 0.4) * 0.12;
        sig[i] = v * env;
        if (fabs(sig[i]) > peak) peak = fabs(sig[i]);
    }
    if (peak > 0.001) {
        for (i = 0; i < n; i++) sig[i] = sig[i] / peak * 0.95;
    }
}

/* Bits per sample: 4 levels -> 2 bits, 8 -> 3 bits, 16 -> 4 bits. */
int bits_per_sample(int levels) {
    int b = 0, p = 1;
    while (p < levels) { p *= 2; b++; }
    return b < 1 ? 1 : b;
}

/* Encode a quantization index as a fixed-width binary PCM code string. */
void encode_pcm(int index, int levels, char *out) {
    int bits = bits_per_sample(levels);
    int i;
    for (i = bits - 1; i >= 0; i--) {
        out[bits - 1 - i] = ((index >> i) & 1) ? '1' : '0';
    }
    out[bits] = '\0';
}

/* SAMPLING: pick values at regular intervals (linear interpolation). */
double sample_at(const double *sig, int n, int s, int count) {
    double pos = ((double)(s + 0.5) / count) * (n - 1);
    int i0 = (int)pos;
    int i1 = i0 + 1;
    double f = pos - i0;
    if (i1 >= n) i1 = n - 1;
    return sig[i0] * (1 - f) + sig[i1] * f;
}

/* QUANTIZATION: amplitude [-1,1] -> [0,1] -> nearest level 0..L-1. */
int quantize(double v, int levels) {
    double norm = (v + 1.0) / 2.0;
    int q = (int)(norm * (levels - 1) + 0.5);
    if (q < 0) q = 0;
    if (q > levels - 1) q = levels - 1;
    return q;
}

/* Simple ASCII waveform so the analog signal is visible in the terminal. */
void print_waveform(const double *sig, int n) {
    int rows = 9, r, i;
    int cols = 60;
    for (r = 0; r < rows; r++) {
        double level = 1.0 - (double)r / (rows - 1) * 2.0; /* +1 .. -1 */
        for (i = 0; i < cols; i++) {
            double v = sig[i * n / cols];
            if (fabs(v - level) < 0.22) putchar('*');
            else if (r == rows / 2) putchar('-');
            else putchar(' ');
        }
        putchar('\n');
    }
    printf("Amplitude (vertical) vs Time (horizontal)\n");
}

int read_int(const char *prompt, int def) {
    char line[64];
    int v;
    printf("%s [%d]: ", prompt, def);
    if (!fgets(line, sizeof line, stdin)) return def;
    if (line[0] == '\n' || line[0] == '\0') return def;
    if (sscanf(line, "%d", &v) != 1) return def;
    return v;
}

int main(void) {
    double sig[WAVE_POINTS];
    int sample_count, levels, noise_pct;
    int s, i, bits, errors = 0, total_bits = 0;
    char code[16];

    printf("Wave2Bit -- Pulse Code Modulation (C version)\n");
    printf("Voice -> Analog -> Sampling -> Quantization -> Encoding -> Noise\n\n");

    sample_count = read_int("Sampling rate (samples, 8-60)", 24);
    if (sample_count < 8) sample_count = 8;
    if (sample_count > 60) sample_count = 60;

    levels = read_int("Quantization levels (4, 8 or 16)", 8);
    if (levels != 4 && levels != 8 && levels != 16) {
        printf("Invalid choice, using 8 levels.\n");
        levels = 8;
    }

    noise_pct = read_int("Noise level (0-100 %%)", 0);
    if (noise_pct < 0) noise_pct = 0;
    if (noise_pct > 100) noise_pct = 100;

    bits = bits_per_sample(levels);
    make_demo_signal(sig, WAVE_POINTS);

    /* Step 2: analog signal */
    printf("\n== 2. Analog Voice Signal ==\n");
    print_waveform(sig, WAVE_POINTS);

    /* Steps 3-5: sampling + quantization + encoding table */
    printf("\n== 3/4/5. Sampling + Quantization + PCM Encoding ==\n");
    printf("Sample  Amplitude  Level  PCM Code\n");
    int show = sample_count < TABLE_ROWS ? sample_count : TABLE_ROWS;
    for (s = 0; s < show; s++) {
        double v = sample_at(sig, WAVE_POINTS, s, sample_count);
        int q = quantize(v, levels);
        encode_pcm(q, levels, code);
        printf("%4d  %9.3f  %5d  %s\n", s + 1, v, q, code);
    }

    /* Step 6: PCM binary stream (from the actual quantized signal) */
    printf("\n== 6. PCM Binary Stream ==\nSpaced: ");
    for (s = 0; s < sample_count; s++) {
        int q = quantize(sample_at(sig, WAVE_POINTS, s, sample_count), levels);
        encode_pcm(q, levels, code);
        printf("%s%c", code, s + 1 < sample_count ? ' ' : '\n');
    }
    printf("Flat:   ");
    for (s = 0; s < sample_count; s++) {
        int q = quantize(sample_at(sig, WAVE_POINTS, s, sample_count), levels);
        encode_pcm(q, levels, code);
        printf("%s", code);
    }
    printf("\n");

    /* Steps 7-8: noise + received data with error count and BER */
    printf("\n== 7/8. Noise + Received PCM Data ==\n");
    printf("TX:     ");
    for (s = 0; s < sample_count; s++) {
        int q = quantize(sample_at(sig, WAVE_POINTS, s, sample_count), levels);
        encode_pcm(q, levels, code);
        printf("%s", code);
    }
    printf("\nRX:     ");
    for (s = 0; s < sample_count; s++) {
        int q = quantize(sample_at(sig, WAVE_POINTS, s, sample_count), levels);
        encode_pcm(q, levels, code);
        for (i = 0; code[i]; i++) {
            char b = code[i];
            char out = b;
            if (noise_pct > 0 && (rand() % 100) < noise_pct)
                out = (b == '0') ? '1' : '0';
            if (out != b) errors++;
            total_bits++;
            putchar(out);
        }
    }
    printf("\nChanged bits are counted below.\n");
    printf("Bit Errors: %d\n", errors);
    printf("Bit Error Rate: %.2f%%\n",
           total_bits ? (double)errors / total_bits * 100.0 : 0.0);

    printf("\nFinal flow: VOICE -> ANALOG -> SAMPLING -> QUANTIZATION -> "
           "ENCODING -> PCM BINARY -> NOISE -> RECEIVED BINARY\n");
    return 0;
}
