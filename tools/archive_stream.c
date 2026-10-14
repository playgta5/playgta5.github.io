#include <archive.h>
#include <archive_entry.h>
#include <emscripten/emscripten.h>
#include <stdint.h>

static struct archive *reader;
static struct archive_entry *current;

EMSCRIPTEN_KEEPALIVE int rar_open(const char *path) {
    if (reader) {
        archive_read_free(reader);
        reader = NULL;
    }
    current = NULL;
    reader = archive_read_new();
    if (!reader) return -1;
    archive_read_support_format_rar(reader);
    archive_read_support_format_rar5(reader);
    const int rc = archive_read_open_filename(reader, path, 64 * 1024);
    return rc == ARCHIVE_OK ? 1 : -1;
}

EMSCRIPTEN_KEEPALIVE int rar_next(void) {
    if (!reader) return -1;
    const int rc = archive_read_next_header(reader, &current);
    if (rc == ARCHIVE_EOF) {
        current = NULL;
        return 0;
    }
    if (rc == ARCHIVE_OK || rc == ARCHIVE_WARN) return 1;
    current = NULL;
    return -1;
}

EMSCRIPTEN_KEEPALIVE const char *rar_path(void) {
    if (!current) return "";
    const char *path = archive_entry_pathname_utf8(current);
    if (!path) path = archive_entry_pathname(current);
    return path ? path : "";
}

EMSCRIPTEN_KEEPALIVE double rar_size(void) {
    if (!current || !archive_entry_size_is_set(current)) return 0.0;
    const la_int64_t size = archive_entry_size(current);
    return size < 0 ? 0.0 : (double)size;
}

EMSCRIPTEN_KEEPALIVE int rar_type(void) {
    if (!current) return 0;
    const mode_t type = archive_entry_filetype(current);
    if (type == AE_IFREG) return 1;
    if (type == AE_IFDIR) return 2;
    return 0;
}

EMSCRIPTEN_KEEPALIVE int rar_read(void *buffer, int capacity) {
    if (!reader || !current || capacity <= 0) return -1;
    const la_ssize_t count = archive_read_data(reader, buffer, (size_t)capacity);
    return count > 2147483647 ? -1 : (int)count;
}

EMSCRIPTEN_KEEPALIVE const char *rar_error(void) {
    if (!reader) return "RAR reader is not open";
    const char *message = archive_error_string(reader);
    return message ? message : "Unknown archive error";
}

EMSCRIPTEN_KEEPALIVE void rar_close(void) {
    if (reader) archive_read_free(reader);
    reader = NULL;
    current = NULL;
}
