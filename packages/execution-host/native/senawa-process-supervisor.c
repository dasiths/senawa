#define _GNU_SOURCE

#include <errno.h>
#include <fcntl.h>
#include <linux/openat2.h>
#include <poll.h>
#include <signal.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

extern char **environ;

enum {
    STATUS_FD = 3,
    ROOT_FD = 4,
    EXEC_STAGE_SETPGID = 1,
    EXEC_STAGE_EXEC = 2,
};

struct exec_error {
    int stage;
    int error_number;
};

struct command_status {
    bool known;
    int exit_code;
    int signal_number;
};

static volatile sig_atomic_t termination_requested = 0;

static void request_termination(int signal_number) {
    (void)signal_number;
    termination_requested = 1;
}

static void write_all(int descriptor, const void *buffer, size_t length) {
    const char *cursor = buffer;
    while (length > 0) {
        ssize_t written = write(descriptor, cursor, length);
        if (written > 0) {
            cursor += written;
            length -= (size_t)written;
        } else if (written < 0 && errno == EINTR) {
            continue;
        } else {
            return;
        }
    }
}

static void report_setup_error(const char *stage, int error_number) {
    dprintf(STATUS_FD, "SENAWA1\tresult=error\tstage=%s\terrno=%d\n", stage, error_number);
}

static void report_ready(void) {
    dprintf(STATUS_FD, "SENAWA1\tresult=ready\n");
}

static void report_command_status(
    const struct command_status *status,
    const char *cleanup
) {
    dprintf(
        STATUS_FD,
        "SENAWA1\tresult=command\tcode=%d\tsignal=%d\tcleanup=%s\n",
        status->exit_code,
        status->signal_number,
        cleanup
    );
}

static int64_t monotonic_milliseconds(void) {
    struct timespec now;
    if (clock_gettime(CLOCK_MONOTONIC, &now) != 0) {
        return -1;
    }
    return (int64_t)now.tv_sec * 1000 + now.tv_nsec / 1000000;
}

static void record_status(
    pid_t process_id,
    pid_t leader,
    int wait_status,
    struct command_status *command
) {
    if (process_id != leader || command->known) {
        return;
    }
    command->known = true;
    command->exit_code = WIFEXITED(wait_status) ? WEXITSTATUS(wait_status) : -1;
    command->signal_number = WIFSIGNALED(wait_status) ? WTERMSIG(wait_status) : 0;
}

static int reap_available(pid_t leader, struct command_status *command) {
    for (;;) {
        int wait_status = 0;
        pid_t process_id = waitpid(-1, &wait_status, WNOHANG);
        if (process_id > 0) {
            record_status(process_id, leader, wait_status, command);
            continue;
        }
        if (process_id == 0) {
            return 0;
        }
        if (errno == EINTR) {
            continue;
        }
        return errno == ECHILD ? 1 : -1;
    }
}

static int leader_has_exited(pid_t leader, struct command_status *command) {
    siginfo_t information;
    memset(&information, 0, sizeof(information));
    if (waitid(P_PID, (id_t)leader, &information, WEXITED | WNOHANG | WNOWAIT) != 0) {
        return errno == EINTR ? 0 : -1;
    }
    if (information.si_pid == 0) {
        return 0;
    }
    command->known = true;
    command->exit_code = information.si_code == CLD_EXITED ? information.si_status : -1;
    command->signal_number = information.si_code == CLD_EXITED ? 0 : information.si_status;
    return 1;
}

static int read_direct_children(pid_t **process_ids, size_t *count) {
    char path[96];
    int path_length = snprintf(
        path,
        sizeof(path),
        "/proc/self/task/%ld/children",
        (long)syscall(SYS_gettid)
    );
    if (path_length < 0 || (size_t)path_length >= sizeof(path)) {
        errno = ENAMETOOLONG;
        return -1;
    }
    FILE *children = fopen(path, "re");
    if (children == NULL) {
        return -1;
    }
    pid_t *items = NULL;
    size_t used = 0;
    size_t capacity = 0;
    long value;
    while (fscanf(children, "%ld", &value) == 1) {
        if (value <= 0 || value > INT32_MAX) {
            fclose(children);
            free(items);
            errno = EINVAL;
            return -1;
        }
        if (used == capacity) {
            size_t next_capacity = capacity == 0 ? 8 : capacity * 2;
            pid_t *next = realloc(items, next_capacity * sizeof(*next));
            if (next == NULL) {
                fclose(children);
                free(items);
                return -1;
            }
            items = next;
            capacity = next_capacity;
        }
        items[used++] = (pid_t)value;
    }
    if (ferror(children) != 0) {
        int read_error = errno == 0 ? EIO : errno;
        fclose(children);
        free(items);
        errno = read_error;
        return -1;
    }
    fclose(children);
    *process_ids = items;
    *count = used;
    return 0;
}

static int signal_direct_children(void) {
    pid_t *process_ids = NULL;
    size_t count = 0;
    if (read_direct_children(&process_ids, &count) != 0) {
        return -1;
    }
    for (size_t index = 0; index < count; index += 1) {
        int pidfd = (int)syscall(SYS_pidfd_open, process_ids[index], 0);
        if (pidfd < 0) {
            if (errno == ESRCH) {
                continue;
            }
            free(process_ids);
            return -1;
        }
        if (syscall(SYS_pidfd_send_signal, pidfd, SIGKILL, NULL, 0) != 0 && errno != ESRCH) {
            int signal_error = errno;
            close(pidfd);
            free(process_ids);
            errno = signal_error;
            return -1;
        }
        close(pidfd);
    }
    free(process_ids);
    return 0;
}

static int cleanup_descendants(
    pid_t leader,
    long grace_milliseconds,
    struct command_status *command,
    const char **cleanup
) {
    bool term_sent = false;
    if (kill(-leader, SIGTERM) == 0) {
        term_sent = true;
    } else if (errno != ESRCH) {
        return -1;
    }

    int64_t started = monotonic_milliseconds();
    if (started < 0) {
        return -1;
    }
    for (;;) {
        int reaped = reap_available(leader, command);
        if (reaped == 1) {
            *cleanup = term_sent ? "terminated" : "not-needed";
            return 0;
        }
        if (reaped < 0) {
            return -1;
        }
        int64_t now = monotonic_milliseconds();
        if (now < 0) {
            return -1;
        }
        if (now - started >= grace_milliseconds) {
            break;
        }
        struct timespec pause = { .tv_sec = 0, .tv_nsec = 10000000 };
        nanosleep(&pause, NULL);
    }

    *cleanup = "forced";
    for (;;) {
        if (signal_direct_children() != 0) {
            return -1;
        }
        for (;;) {
            int wait_status = 0;
            pid_t process_id = waitpid(-1, &wait_status, 0);
            if (process_id > 0) {
                record_status(process_id, leader, wait_status, command);
                break;
            }
            if (process_id < 0 && errno == EINTR) {
                continue;
            }
            if (process_id < 0 && errno == ECHILD) {
                return 0;
            }
            return -1;
        }
    }
}

static long parse_grace(const char *value) {
    char *end = NULL;
    errno = 0;
    long parsed = strtol(value, &end, 10);
    if (errno != 0 || end == value || *end != '\0' || parsed <= 0 || parsed > INT32_MAX) {
        return -1;
    }
    return parsed;
}

static void child_fail(int descriptor, int stage) {
    struct exec_error error = { .stage = stage, .error_number = errno };
    write_all(descriptor, &error, sizeof(error));
    _exit(127);
}

int main(int argument_count, char **arguments) {
    if (argument_count < 5 || strcmp(arguments[3], "--") != 0) {
        report_setup_error("arguments", EINVAL);
        return 125;
    }
    long grace_milliseconds = parse_grace(arguments[2]);
    if (grace_milliseconds < 0) {
        report_setup_error("arguments", EINVAL);
        return 125;
    }
    if (prctl(PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) != 0) {
        report_setup_error("subreaper", errno);
        return 125;
    }

    struct sigaction action;
    memset(&action, 0, sizeof(action));
    action.sa_handler = request_termination;
    sigemptyset(&action.sa_mask);
    if (sigaction(SIGTERM, &action, NULL) != 0 || sigaction(SIGINT, &action, NULL) != 0) {
        report_setup_error("signals", errno);
        return 125;
    }

    struct open_how how = {
        .flags = O_PATH | O_DIRECTORY | O_CLOEXEC,
        .resolve = RESOLVE_BENEATH | RESOLVE_NO_MAGICLINKS | RESOLVE_NO_SYMLINKS,
    };
    int working_directory = (int)syscall(
        SYS_openat2,
        ROOT_FD,
        arguments[1],
        &how,
        sizeof(how)
    );
    if (working_directory < 0) {
        report_setup_error("openat2", errno);
        return 125;
    }
    if (fchdir(working_directory) != 0) {
        int directory_error = errno;
        close(working_directory);
        report_setup_error("fchdir", directory_error);
        return 125;
    }
    close(working_directory);

    int exec_pipe[2];
    if (pipe2(exec_pipe, O_CLOEXEC) != 0) {
        report_setup_error("exec-pipe", errno);
        return 125;
    }
    pid_t leader = fork();
    if (leader < 0) {
        int fork_error = errno;
        close(exec_pipe[0]);
        close(exec_pipe[1]);
        report_setup_error("fork", fork_error);
        return 125;
    }
    if (leader == 0) {
        close(exec_pipe[0]);
        if (setpgid(0, 0) != 0) {
            child_fail(exec_pipe[1], EXEC_STAGE_SETPGID);
        }
        close(STATUS_FD);
        close(ROOT_FD);
        execvpe(arguments[4], &arguments[4], environ);
        child_fail(exec_pipe[1], EXEC_STAGE_EXEC);
    }

    close(exec_pipe[1]);
    struct exec_error exec_error;
    ssize_t exec_error_bytes;
    do {
        exec_error_bytes = read(exec_pipe[0], &exec_error, sizeof(exec_error));
    } while (exec_error_bytes < 0 && errno == EINTR);
    close(exec_pipe[0]);
    if (exec_error_bytes != 0) {
        if (exec_error_bytes == (ssize_t)sizeof(exec_error)) {
            report_setup_error(
                exec_error.stage == EXEC_STAGE_EXEC ? "exec" : "setpgid",
                exec_error.error_number
            );
        } else {
            report_setup_error("exec-pipe", exec_error_bytes < 0 ? errno : EPROTO);
        }
        while (waitpid(leader, NULL, 0) < 0 && errno == EINTR) {
        }
        return 126;
    }

    struct command_status command = {
        .known = false,
        .exit_code = -1,
        .signal_number = 0,
    };
    report_ready();
    while (!termination_requested) {
        int exited = leader_has_exited(leader, &command);
        if (exited > 0) {
            break;
        }
        if (exited < 0) {
            report_setup_error("wait", errno);
            return 125;
        }
        struct pollfd status_poll = { .fd = STATUS_FD, .events = 0 };
        poll(&status_poll, 1, 10);
    }

    const char *cleanup = "not-needed";
    if (cleanup_descendants(leader, grace_milliseconds, &command, &cleanup) != 0) {
        report_setup_error("cleanup", errno == 0 ? EIO : errno);
        return 125;
    }
    if (!command.known) {
        report_setup_error("leader-status", ECHILD);
        return 125;
    }
    report_command_status(&command, cleanup);
    return 0;
}