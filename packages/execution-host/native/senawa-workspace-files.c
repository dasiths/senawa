#define _GNU_SOURCE

#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <linux/openat2.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>

enum { CONTROL_FD = 3 };

static void fail(const char *message) {
    dprintf(STDERR_FILENO, "%s: %s\n", message, strerror(errno));
    exit(1);
}

static void write_all(int descriptor, const void *buffer, size_t length) {
    const unsigned char *cursor = buffer;
    while (length > 0) {
        ssize_t written = write(descriptor, cursor, length);
        if (written > 0) {
            cursor += written;
            length -= (size_t)written;
        } else if (written < 0 && errno == EINTR) {
            continue;
        } else {
            fail("write failed");
        }
    }
}

static unsigned char *read_bounded(int descriptor, size_t maximum, size_t *length) {
    unsigned char *buffer = malloc(maximum + 1U);
    if (buffer == NULL) fail("allocation failed");
    size_t used = 0;
    while (used <= maximum) {
        ssize_t count = read(descriptor, buffer + used, maximum + 1U - used);
        if (count > 0) {
            used += (size_t)count;
            continue;
        }
        if (count == 0) break;
        if (errno != EINTR) fail("read failed");
    }
    if (used > maximum) {
        errno = EFBIG;
        fail("input exceeds bound");
    }
    *length = used;
    return buffer;
}

static int open_beneath(int root, const char *path, uint64_t flags, mode_t mode) {
    struct open_how how = {
        .flags = flags,
        .mode = mode,
        .resolve = RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS | RESOLVE_NO_MAGICLINKS | RESOLVE_NO_XDEV,
    };
    return (int)syscall(SYS_openat2, root, path, &how, sizeof(how));
}

static void split_path(const char *path, char **parent, const char **name) {
    if (path[0] == '\0' || path[0] == '/') {
        errno = EINVAL;
        fail("path must be relative");
    }
    char *copy = strdup(path);
    if (copy == NULL) fail("allocation failed");
    char *separator = strrchr(copy, '/');
    if (separator == NULL) {
        *parent = copy;
        strcpy(copy, ".");
        *name = path;
        return;
    }
    if (separator[1] == '\0') {
        errno = EINVAL;
        fail("path name is empty");
    }
    *separator = '\0';
    *parent = copy;
    *name = path + (separator - copy) + 1;
}

/*
 * Opens the parent of a write, making the directories it names.
 *
 * There is no tool for making a directory, so a nested path could not be
 * written at all: an agent asked for scripts/check.mjs, was told the parent
 * could not be opened, and had nowhere to go. Each component is created and
 * then reopened through the same guarded resolver, so making a directory is
 * held to the same rules as opening one.
 */
static int open_parent_making(int root, const char *parent_path) {
    int current = open_beneath(root, ".", O_RDONLY | O_DIRECTORY | O_CLOEXEC, 0);
    if (current < 0) fail("workspace root open failed");
    if (strcmp(parent_path, ".") == 0) return current;

    char *copy = strdup(parent_path);
    if (copy == NULL) fail("allocation failed");
    for (char *cursor = copy; cursor != NULL && *cursor != '\0';) {
        char *separator = strchr(cursor, '/');
        if (separator != NULL) *separator = '\0';
        if (*cursor != '\0' && strcmp(cursor, ".") != 0) {
            if (mkdirat(current, cursor, 0700) != 0 && errno != EEXIST) {
                fail("workspace directory create failed");
            }
            int next = open_beneath(current, cursor, O_RDONLY | O_DIRECTORY | O_CLOEXEC, 0);
            if (next < 0) fail("workspace directory open failed");
            close(current);
            current = next;
        }
        cursor = separator == NULL ? NULL : separator + 1;
    }
    free(copy);
    return current;
}

static void failpoint(void) {    if (getenv("SENAWA_WORKSPACE_FAIL_BEFORE_RENAME") == NULL) return;
    unsigned char byte = 1;
    write_all(CONTROL_FD, &byte, 1);
    for (;;) {
        ssize_t count = read(CONTROL_FD, &byte, 1);
        if (count == 1) return;
        if (count < 0 && errno == EINTR) continue;
        fail("failpoint control failed");
    }
}

static void atomic_replace(
    int root,
    const char *path,
    const unsigned char *bytes,
    size_t length,
    mode_t fallback_mode,
    const struct stat *expected_target
) {
    char *parent_path = NULL;
    const char *name = NULL;
    split_path(path, &parent_path, &name);
    // A patch has to match content that already exists, so it never makes a
    // directory; only a plain write does.
    int parent = expected_target == NULL
        ? open_parent_making(root, parent_path)
        : open_beneath(root, parent_path, O_RDONLY | O_DIRECTORY | O_CLOEXEC, 0);
    if (parent < 0) fail("workspace parent open failed");

    mode_t mode = fallback_mode;
    int target = open_beneath(parent, name, O_RDONLY | O_CLOEXEC, 0);
    if (target >= 0) {
        struct stat metadata;
        if (fstat(target, &metadata) != 0 || !S_ISREG(metadata.st_mode)) {
            errno = EINVAL;
            fail("workspace target is not a regular file");
        }
        if (expected_target != NULL &&
            (metadata.st_dev != expected_target->st_dev || metadata.st_ino != expected_target->st_ino)) {
            errno = ESTALE;
            fail("workspace patch target changed");
        }
        mode = metadata.st_mode & 0777;
        close(target);
    } else if (errno != ENOENT) {
        fail("workspace target open failed");
    }

    char temporary[96];
    int size = snprintf(temporary, sizeof(temporary), ".senawa-write-%ld", (long)getpid());
    if (size < 1 || (size_t)size >= sizeof(temporary)) {
        errno = EINVAL;
        fail("temporary name failed");
    }
    int staged = openat(parent, temporary, O_CREAT | O_EXCL | O_WRONLY | O_CLOEXEC | O_NOFOLLOW, mode);
    if (staged < 0) fail("workspace temporary open failed");
    write_all(staged, bytes, length);
    if (fsync(staged) != 0 || close(staged) != 0) fail("workspace temporary sync failed");
    failpoint();
    if (expected_target != NULL) {
        struct stat current;
        if (fstatat(parent, name, &current, AT_SYMLINK_NOFOLLOW) != 0 ||
            !S_ISREG(current.st_mode) || current.st_dev != expected_target->st_dev ||
            current.st_ino != expected_target->st_ino) {
            unlinkat(parent, temporary, 0);
            errno = ESTALE;
            fail("workspace patch target changed before commit");
        }
    }
    if (renameat(parent, temporary, parent, name) != 0) {
        unlinkat(parent, temporary, 0);
        fail("workspace atomic rename failed");
    }
    if (fsync(parent) != 0) fail("workspace parent sync failed");
    close(parent);
    free(parent_path);
}

static size_t parse_bound(const char *value) {
    char *end = NULL;
    errno = 0;
    unsigned long long parsed = strtoull(value, &end, 10);
    if (errno != 0 || end == value || *end != '\0' || parsed == 0 || parsed > SIZE_MAX) {
        errno = EINVAL;
        fail("invalid bound");
    }
    return (size_t)parsed;
}

static size_t parse_size(const char *value) {
    char *end = NULL;
    errno = 0;
    unsigned long long parsed = strtoull(value, &end, 10);
    if (errno != 0 || end == value || *end != '\0' || parsed > SIZE_MAX) {
        errno = EINVAL;
        fail("invalid size");
    }
    return (size_t)parsed;
}

static void read_operation(int root, const char *path, size_t maximum) {
    int file = open_beneath(root, path, O_RDONLY | O_CLOEXEC, 0);
    if (file < 0) fail("workspace file open failed");
    struct stat metadata;
    if (fstat(file, &metadata) != 0 || !S_ISREG(metadata.st_mode)) {
        errno = EINVAL;
        fail("workspace path is not a regular file");
    }
    if ((uint64_t)metadata.st_size > maximum) {
        errno = EFBIG;
        fail("workspace file exceeds bound");
    }
    size_t length = 0;
    unsigned char *bytes = read_bounded(file, maximum, &length);
    write_all(STDOUT_FILENO, bytes, length);
    free(bytes);
    close(file);
}

static bool same_stable_metadata(const struct stat *left, const struct stat *right) {
    return left->st_dev == right->st_dev &&
        left->st_ino == right->st_ino &&
        left->st_mode == right->st_mode &&
        left->st_nlink == right->st_nlink &&
        left->st_size == right->st_size &&
        left->st_ctim.tv_sec == right->st_ctim.tv_sec &&
        left->st_ctim.tv_nsec == right->st_ctim.tv_nsec &&
        left->st_mtim.tv_sec == right->st_mtim.tv_sec &&
        left->st_mtim.tv_nsec == right->st_mtim.tv_nsec;
}

static void stable_read_operation(int root, const char *path, size_t maximum) {
    int file = open_beneath(root, path, O_RDONLY | O_CLOEXEC | O_NONBLOCK, 0);
    if (file < 0) fail("resource open failed");
    struct stat before;
    if (fstat(file, &before) != 0) fail("resource metadata failed");
    if (!S_ISREG(before.st_mode)) {
        errno = EINVAL;
        fail("resource is not a regular file");
    }
    if (before.st_nlink != 1) {
        errno = EMLINK;
        fail("resource has multiple hard links");
    }
    if (before.st_size < 0 || (uint64_t)before.st_size > maximum) {
        errno = EFBIG;
        fail("resource exceeds bound");
    }
    size_t length = 0;
    unsigned char *bytes = read_bounded(file, maximum, &length);
    struct stat after;
    if (fstat(file, &after) != 0 || !same_stable_metadata(&before, &after) ||
        (uint64_t)after.st_size != length) {
        errno = ESTALE;
        fail("resource changed during read");
    }
    failpoint();
    int current = open_beneath(root, path, O_RDONLY | O_CLOEXEC | O_NONBLOCK, 0);
    if (current < 0) {
        errno = ESTALE;
        fail("resource path changed after read");
    }
    struct stat current_metadata;
    if (fstat(current, &current_metadata) != 0 ||
        !same_stable_metadata(&after, &current_metadata)) {
        errno = ESTALE;
        fail("resource path changed after read");
    }
    close(current);
    write_all(STDOUT_FILENO, bytes, length);
    free(bytes);
    close(file);
}

static void print_hex(const unsigned char *bytes, size_t length) {
    static const char digits[] = "0123456789abcdef";
    for (size_t index = 0; index < length; index += 1) {
        unsigned char pair[2] = {
            (unsigned char)digits[bytes[index] >> 4],
            (unsigned char)digits[bytes[index] & 15U],
        };
        write_all(STDOUT_FILENO, pair, sizeof(pair));
    }
}

static void list_operation(int root, const char *path, size_t maximum) {
    int directory = open_beneath(root, path, O_RDONLY | O_DIRECTORY | O_CLOEXEC, 0);
    if (directory < 0) fail("workspace directory open failed");
    DIR *stream = fdopendir(directory);
    if (stream == NULL) fail("workspace directory stream failed");
    size_t count = 0;
    struct dirent *entry;
    while ((entry = readdir(stream)) != NULL) {
        if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0) continue;
        count += 1;
        if (count > maximum) {
            errno = EFBIG;
            fail("workspace list exceeds bound");
        }
        struct stat metadata;
        if (fstatat(directory, entry->d_name, &metadata, AT_SYMLINK_NOFOLLOW) != 0) {
            fail("workspace list metadata failed");
        }
        char type = S_ISREG(metadata.st_mode) ? 'f' : S_ISDIR(metadata.st_mode) ? 'd' : S_ISLNK(metadata.st_mode) ? 'l' : '?';
        if (type == '?') {
            errno = EINVAL;
            fail("unsupported workspace file type");
        }
        print_hex((const unsigned char *)entry->d_name, strlen(entry->d_name));
        dprintf(STDOUT_FILENO, "\t%c\t%lld\n", type, (long long)metadata.st_size);
    }
    closedir(stream);
}

static void patch_operation(int root, const char *path, size_t maximum) {
    size_t input_length = 0;
    unsigned char *input = read_bounded(STDIN_FILENO, maximum * 2U + 64U, &input_length);
    unsigned char *newline = memchr(input, '\n', input_length);
    if (newline == NULL) {
        errno = EINVAL;
        fail("patch framing is invalid");
    }
    *newline = '\0';
    size_t expected_length = parse_size((const char *)input);
    size_t header_length = (size_t)(newline - input) + 1U;
    if (expected_length > maximum || input_length < header_length + expected_length) {
        errno = EINVAL;
        fail("patch framing exceeds bound");
    }
    size_t replacement_length = input_length - header_length - expected_length;
    if (replacement_length > maximum) {
        errno = EFBIG;
        fail("patch replacement exceeds bound");
    }
    int target = open_beneath(root, path, O_RDONLY | O_CLOEXEC, 0);
    if (target < 0) fail("workspace patch target open failed");
    struct stat metadata;
    if (fstat(target, &metadata) != 0 || !S_ISREG(metadata.st_mode)) {
        errno = EINVAL;
        fail("workspace patch target is not regular");
    }
    size_t actual_length = 0;
    unsigned char *actual = read_bounded(target, maximum, &actual_length);
    close(target);
    if (actual_length != expected_length || memcmp(actual, input + header_length, expected_length) != 0) {
        free(actual);
        free(input);
        errno = ESTALE;
        fail("workspace patch expected text does not match");
    }
    free(actual);
    atomic_replace(
        root,
        path,
        input + header_length + expected_length,
        replacement_length,
        metadata.st_mode & 0777,
        &metadata
    );
    free(input);
}

int main(int argc, char **argv) {
    if (argc < 4) {
        errno = EINVAL;
        fail("usage: operation root path [bound]");
    }
    int root = open(argv[2], O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
    if (root < 0) fail("workspace root open failed");
    if (flock(root, strcmp(argv[1], "read") == 0 || strcmp(argv[1], "stable-read") == 0 || strcmp(argv[1], "list") == 0 ? LOCK_SH : LOCK_EX) != 0) {
        fail("workspace root lock failed");
    }
    if (strcmp(argv[1], "read") == 0 && argc == 5) {
        read_operation(root, argv[3], parse_bound(argv[4]));
    } else if (strcmp(argv[1], "stable-read") == 0 && argc == 5) {
        stable_read_operation(root, argv[3], parse_bound(argv[4]));
    } else if (strcmp(argv[1], "list") == 0 && argc == 5) {
        list_operation(root, argv[3], parse_bound(argv[4]));
    } else if (strcmp(argv[1], "write") == 0 && argc == 4) {
        size_t length = 0;
        unsigned char *bytes = read_bounded(STDIN_FILENO, 1048576U, &length);
        atomic_replace(root, argv[3], bytes, length, 0644, NULL);
        free(bytes);
    } else if (strcmp(argv[1], "patch") == 0 && argc == 5) {
        patch_operation(root, argv[3], parse_bound(argv[4]));
    } else {
        errno = EINVAL;
        fail("workspace operation is invalid");
    }
    if (flock(root, LOCK_UN) != 0) fail("workspace root unlock failed");
    close(root);
    return 0;
}