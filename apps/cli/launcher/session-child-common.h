/* Portable pieces of the session child, shared by the POSIX child
 * (`session-child.h`) and the Windows child (`windows-session-child.h`): a
 * small reader for the top-level fields of one JSON object, a JSON writer,
 * FNV-1a 64 (file names shared with `hub-ipc.ts`) and base64 decoding. */
#include <ctype.h>

#define CHILD_IPC_VERSION 1
#define CHILD_MAX_FRAME (1024 * 1024)
#define CHILD_MAX_INPUT (4 * 1024 * 1024)

/* ---- small JSON reader: top-level fields of one object ------------------ */

typedef struct { const unsigned char *p, *end; } jcur;

static void jws(jcur *c) {
    while (c->p < c->end && (*c->p == ' ' || *c->p == '\t' || *c->p == '\n' || *c->p == '\r')) c->p++;
}

static int jhex(const unsigned char *s, unsigned *out) {
    unsigned v = 0;
    for (int i = 0; i < 4; i++) {
        unsigned char ch = s[i];
        v <<= 4;
        if (ch >= '0' && ch <= '9') v |= (unsigned)(ch - '0');
        else if (ch >= 'a' && ch <= 'f') v |= (unsigned)(ch - 'a' + 10);
        else if (ch >= 'A' && ch <= 'F') v |= (unsigned)(ch - 'A' + 10);
        else return 0;
    }
    *out = v;
    return 1;
}

/* Reads one string at the cursor. With `out`, decodes it (escapes, \u pairs
 * to UTF-8) and fails when it does not fit; without, only skips it. */
static int jstring(jcur *c, char *out, size_t size) {
    size_t n = 0;
    if (c->p >= c->end || *c->p != '"') return 0;
    c->p++;
    while (c->p < c->end) {
        unsigned char ch = *c->p++;
        if (ch == '"') {
            if (out) { if (n >= size) return 0; out[n] = 0; }
            return 1;
        }
        if (ch < 0x20) return 0;
        unsigned code = ch;
        int raw = 1;
        if (ch == '\\') {
            if (c->p >= c->end) return 0;
            unsigned char e = *c->p++;
            raw = 0;
            switch (e) {
                case '"': code = '"'; break;
                case '\\': code = '\\'; break;
                case '/': code = '/'; break;
                case 'b': code = '\b'; break;
                case 'f': code = '\f'; break;
                case 'n': code = '\n'; break;
                case 'r': code = '\r'; break;
                case 't': code = '\t'; break;
                case 'u': {
                    if (c->end - c->p < 4 || !jhex(c->p, &code)) return 0;
                    c->p += 4;
                    if (code >= 0xD800 && code <= 0xDBFF) {
                        unsigned low;
                        if (c->end - c->p < 6 || c->p[0] != '\\' || c->p[1] != 'u' || !jhex(c->p + 2, &low) ||
                            low < 0xDC00 || low > 0xDFFF) return 0;
                        c->p += 6;
                        code = 0x10000 + ((code - 0xD800) << 10) + (low - 0xDC00);
                    } else if (code >= 0xDC00 && code <= 0xDFFF) return 0;
                    break;
                }
                default: return 0;
            }
        }
        if (!out) continue;
        unsigned char bytes[4];
        int count;
        if (raw || code < 0x80) { bytes[0] = (unsigned char)code; count = 1; }
        else if (code < 0x800) { bytes[0] = (unsigned char)(0xC0 | (code >> 6)); bytes[1] = (unsigned char)(0x80 | (code & 0x3F)); count = 2; }
        else if (code < 0x10000) {
            bytes[0] = (unsigned char)(0xE0 | (code >> 12)); bytes[1] = (unsigned char)(0x80 | ((code >> 6) & 0x3F));
            bytes[2] = (unsigned char)(0x80 | (code & 0x3F)); count = 3;
        } else {
            bytes[0] = (unsigned char)(0xF0 | (code >> 18)); bytes[1] = (unsigned char)(0x80 | ((code >> 12) & 0x3F));
            bytes[2] = (unsigned char)(0x80 | ((code >> 6) & 0x3F)); bytes[3] = (unsigned char)(0x80 | (code & 0x3F)); count = 4;
        }
        if (n + (size_t)count >= size) return 0;
        memcpy(out + n, bytes, (size_t)count);
        n += (size_t)count;
    }
    return 0;
}

static int jvalue(jcur *c, int depth) {
    jws(c);
    if (c->p >= c->end || depth > 64) return 0;
    unsigned char ch = *c->p;
    if (ch == '"') return jstring(c, NULL, 0);
    if (ch == '{' || ch == '[') {
        unsigned char close = ch == '{' ? '}' : ']';
        c->p++;
        jws(c);
        if (c->p < c->end && *c->p == close) { c->p++; return 1; }
        for (;;) {
            if (ch == '{') {
                jws(c);
                if (!jstring(c, NULL, 0)) return 0;
                jws(c);
                if (c->p >= c->end || *c->p != ':') return 0;
                c->p++;
            }
            if (!jvalue(c, depth + 1)) return 0;
            jws(c);
            if (c->p >= c->end) return 0;
            if (*c->p == ',') { c->p++; continue; }
            if (*c->p == close) { c->p++; return 1; }
            return 0;
        }
    }
    const unsigned char *start = c->p;
    while (c->p < c->end && (isalnum(*c->p) || *c->p == '-' || *c->p == '+' || *c->p == '.')) c->p++;
    return c->p > start;
}

/* 1: string decoded into out; 2: a non-string value copied raw; 0: absent;
 * -1: the document is not one well-formed object or the value does not fit. */
static int json_field(const char *text, size_t length, const char *key, char *out, size_t size) {
    jcur c = { (const unsigned char *)text, (const unsigned char *)text + length };
    int found = 0;
    jws(&c);
    if (c.p >= c.end || *c.p != '{') return -1;
    c.p++;
    jws(&c);
    if (c.p < c.end && *c.p == '}') { c.p++; goto done; }
    for (;;) {
        char name[128];
        jws(&c);
        jcur probe = c;
        int named = jstring(&probe, name, sizeof(name));
        if (!named && !jstring(&c, NULL, 0)) return -1;
        if (named) c = probe;
        jws(&c);
        if (c.p >= c.end || *c.p != ':') return -1;
        c.p++;
        jws(&c);
        if (named && !found && !strcmp(name, key)) {
            if (c.p < c.end && *c.p == '"') {
                if (!jstring(&c, out, size)) return -1;
                found = 1;
            } else {
                const unsigned char *start = c.p;
                if (!jvalue(&c, 1)) return -1;
                size_t raw = (size_t)(c.p - start);
                if (raw >= size) return -1;
                memcpy(out, start, raw);
                out[raw] = 0;
                found = 2;
            }
        } else if (!jvalue(&c, 1)) return -1;
        jws(&c);
        if (c.p >= c.end) return -1;
        if (*c.p == ',') { c.p++; continue; }
        if (*c.p == '}') { c.p++; break; }
        return -1;
    }
done:
    jws(&c);
    return c.p == c.end ? found : -1;
}

/* ---- small JSON writer ------------------------------------------------- */

typedef struct { char *data; size_t length, capacity; int failed; } jbuf;

static void jb_raw(jbuf *b, const char *text, size_t n) {
    if (b->failed) return;
    if (b->length + n + 1 > b->capacity) {
        size_t capacity = b->capacity ? b->capacity : 256;
        while (b->length + n + 1 > capacity) capacity *= 2;
        char *grown = realloc(b->data, capacity);
        if (!grown) { b->failed = 1; return; }
        b->data = grown;
        b->capacity = capacity;
    }
    memcpy(b->data + b->length, text, n);
    b->length += n;
    b->data[b->length] = 0;
}

static void jb_text(jbuf *b, const char *text) { jb_raw(b, text, strlen(text)); }

static void jb_string(jbuf *b, const char *value) {
    jb_raw(b, "\"", 1);
    for (const unsigned char *s = (const unsigned char *)value; *s; s++) {
        char escaped[8];
        if (*s == '"' || *s == '\\') { escaped[0] = '\\'; escaped[1] = (char)*s; jb_raw(b, escaped, 2); }
        else if (*s < 0x20) { snprintf(escaped, sizeof(escaped), "\\u%04x", *s); jb_raw(b, escaped, 6); }
        else jb_raw(b, (const char *)s, 1);
    }
    jb_raw(b, "\"", 1);
}

static void jb_field(jbuf *b, const char *key, const char *value) {
    jb_raw(b, b->length > 1 ? "," : "", b->length > 1 ? 1 : 0);
    jb_string(b, key);
    jb_raw(b, ":", 1);
    jb_string(b, value);
}

static void jb_number(jbuf *b, const char *key, long long value) {
    char text[32];
    snprintf(text, sizeof(text), "%lld", value);
    jb_raw(b, b->length > 1 ? "," : "", b->length > 1 ? 1 : 0);
    jb_string(b, key);
    jb_raw(b, ":", 1);
    jb_text(b, text);
}

static unsigned long long fnv64(const char *text) {
    unsigned long long hash = 0xcbf29ce484222325ULL;
    for (const unsigned char *s = (const unsigned char *)text; *s; s++) {
        hash ^= *s;
        hash *= 0x100000001b3ULL;
    }
    return hash;
}

static int base64_decode(const char *text, unsigned char *out, size_t size, size_t *length) {
    unsigned buffer = 0;
    int bits = 0;
    size_t n = 0;
    for (const char *s = text; *s && *s != '='; s++) {
        int v;
        char ch = *s;
        if (ch >= 'A' && ch <= 'Z') v = ch - 'A';
        else if (ch >= 'a' && ch <= 'z') v = ch - 'a' + 26;
        else if (ch >= '0' && ch <= '9') v = ch - '0' + 52;
        else if (ch == '+') v = 62;
        else if (ch == '/') v = 63;
        else return 0;
        buffer = (buffer << 6) | (unsigned)v;
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            if (n >= size) return 0;
            out[n++] = (unsigned char)((buffer >> bits) & 0xFF);
        }
    }
    *length = n;
    return 1;
}

