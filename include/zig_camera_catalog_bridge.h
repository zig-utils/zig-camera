#ifndef ZIG_CAMERA_CATALOG_BRIDGE_H
#define ZIG_CAMERA_CATALOG_BRIDGE_H
#include <stdint.h>
#include <stddef.h>
/* Internal borrowed-value bridge. Callbacks copy synchronously into Zig-owned
 * bounded storage. Never retain these pointers or invoke from manager callbacks. */
typedef struct {
    uint32_t group, id, app_id, native_type, flags, extent, kind;
    const char *name;
    size_t name_length;
    const char *vendor;
    size_t vendor_length;
} zcd_catalog_record;
typedef struct {
    uint32_t role, kind, native_type, flags, count;
    const uint8_t *data;
    size_t length;
    const char *label;
    size_t label_length;
} zcd_catalog_value;
typedef struct {
    void *context;
    int (*begin)(void *, const zcd_catalog_record *);
    int (*value)(void *, const zcd_catalog_value *);
    int (*end)(void *);
    /* Metadata-list preselection: 1 keeps, 0 skips before visiting a value,
     * negative propagates an error. No callback or pointer is retained. */
    int (*select)(void *, const zcd_catalog_record *);
    /* Zero retains the standard 4 MiB per-value ceiling. Zig validates any
     * larger caller-owned snapshot budget before constructing this sink. */
    uint64_t max_value_bytes;
} zcd_catalog_sink;
typedef struct {
    zcd_catalog_record record;
    zcd_catalog_value value;
} zcd_control_input;
/* Internal request-local photo values; valid bits: digital gain=1, wall UTC=2.
 * No heap allocation or metadata serialization is required to query these. */
typedef struct { uint32_t valid; float digital_gain; int64_t wallclock_ns; } zcd_photo_metadata;
#endif
