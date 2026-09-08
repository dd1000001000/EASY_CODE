/* Harbor-only Linux supervisor. No namespaces or privileged Docker required.
 * Landlock ABI >= 6: filesystem allowlist + signal/abstract-socket scoping.
 * seccomp: anonymous local socketpairs only; no network sockets, io_uring,
 * namespace escape or privileged inspection.
 * The root supervisor is outside the target domain and reaps ALL descendants.
 */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/audit.h>
#include <linux/capability.h>
#include <linux/filter.h>
#include <linux/seccomp.h>
#include <linux/securebits.h>
#include <signal.h>
#include <semaphore.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/vfs.h>
#include <sys/statvfs.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

#if defined(__x86_64__)
#define NATIVE_ARCH AUDIT_ARCH_X86_64
#elif defined(__aarch64__)
#define NATIVE_ARCH AUDIT_ARCH_AARCH64
#else
#error Unsupported Harbor architecture
#endif
#ifndef SYS_landlock_create_ruleset
#define SYS_landlock_create_ruleset 444
#define SYS_landlock_add_rule 445
#define SYS_landlock_restrict_self 446
#endif
#define READ_ACCESS ((1ULL << 0) | (1ULL << 2) | (1ULL << 3))
#define WRITE_ACCESS ((1ULL << 1) | (0x3ffULL << 4) | (1ULL << 14))
#define FILE_ACCESS ((1ULL << 0) | (1ULL << 1) | (1ULL << 2) | (1ULL << 14))
#define MAX_FIELDS 32768
#define SHM_ACCESS ((1ULL << 1) | (1ULL << 2) | (1ULL << 3) | (1ULL << 5) | (1ULL << 8) | (1ULL << 13) | (1ULL << 14))
struct ruleset_attr { uint64_t fs, net, scoped; };
struct path_attr { uint64_t access; int32_t parent_fd; } __attribute__((packed));
static volatile sig_atomic_t stopping;
static const char *command_id;
static void stop_handler(int sig) { (void)sig; stopping = 1; }
static void die(const char *what) { perror(what); exit(78); }
static double now(void) { struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t); return t.tv_sec + t.tv_nsec / 1e9; }

/* fd 3 carries framed JSON only; the target never inherits it. */
static void control(const char *json) {
    static const char alphabet[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    char encoded[4096]; size_t n = strlen(json), out = 0;
    if (n > 2000) die("control bound");
    for (size_t i = 0; i < n; i += 3) {
        uint32_t v = (unsigned char)json[i] << 16;
        if (i + 1 < n) v |= (unsigned char)json[i + 1] << 8;
        if (i + 2 < n) v |= (unsigned char)json[i + 2];
        encoded[out++] = alphabet[(v >> 18) & 63]; encoded[out++] = alphabet[(v >> 12) & 63];
        if (i + 1 < n) encoded[out++] = alphabet[(v >> 6) & 63];
        if (i + 2 < n) encoded[out++] = alphabet[v & 63];
    }
    encoded[out] = 0;
    if (dprintf(3, "[[EASY_CODE_SRT:%s:%s]]\n", command_id, encoded) < 0) stopping = 1;
}

static void check_kernel(void) {
    if (geteuid() != 0 || access("/.dockerenv", F_OK)) { errno = EPERM; die("Harbor requires root inside Docker"); }
    int abi = syscall(SYS_landlock_create_ruleset, NULL, 0, 1);
    if (abi < 6) { errno = ENOTSUP; die("Harbor requires Landlock ABI 6 (including signal scoping)"); }
    struct stat st; struct statfs fs; struct statvfs vfs;
    if (lstat("/dev/shm", &st) || !S_ISDIR(st.st_mode) || statfs("/dev/shm", &fs) ||
        fs.f_type != 0x01021994 || statvfs("/dev/shm", &vfs) ||
        !(vfs.f_flag & ST_NOSUID) || !(vfs.f_flag & ST_NODEV) || !(vfs.f_flag & ST_NOEXEC) ||
        (vfs.f_flag & ST_RDONLY) || !vfs.f_frsize || !vfs.f_blocks ||
        vfs.f_blocks > (256ULL * 1024 * 1024) / vfs.f_frsize) {
        errno = EPERM; die("Harbor requires bounded noexec,nodev,nosuid shared-memory tmpfs (at most 256 MiB)");
    }
}

static int ruleset(void) {
    struct ruleset_attr a = {READ_ACCESS | WRITE_ACCESS, 0, 3};
    int fd = syscall(SYS_landlock_create_ruleset, &a, sizeof(a), 0);
    if (fd < 0) die("landlock create");
    return fd;
}

static void rule(int fd, const char *p, uint64_t rights) {
    int item = open(p, O_PATH | O_CLOEXEC | O_NOFOLLOW);
    if (item < 0) die("landlock path");
    struct stat s; if (fstat(item, &s)) die("landlock stat");
    if (!S_ISDIR(s.st_mode)) rights &= FILE_ACCESS;
    struct path_attr a = {rights, item};
    if (rights && syscall(SYS_landlock_add_rule, fd, 1, &a, 0)) die("landlock add");
    close(item);
}

#define DENY_NR(nr) BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, nr, 0, 1), BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM)
#define REQUIRE_WORD(offset, value) \
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offset), \
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, value, 1, 0), \
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM)

static void local_ipc_filters(void) {
    /* Separate conjunctive filters keep branch offsets small. The main filter
     * has already checked the native ABI and denies socket/connect/bind and
     * ancillary-message syscalls. No inherited Runtime fds reach exec. */
    struct sock_filter pair[] = {
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_socketpair, 1, 0),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
        REQUIRE_WORD(offsetof(struct seccomp_data, args[0]), AF_UNIX),
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[1])),
        BPF_STMT(BPF_ALU | BPF_AND | BPF_K, ~(SOCK_CLOEXEC | SOCK_NONBLOCK)),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SOCK_STREAM, 3, 0),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SOCK_DGRAM, 2, 0),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SOCK_SEQPACKET, 1, 0),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM),
        REQUIRE_WORD(offsetof(struct seccomp_data, args[2]), 0),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
    };
    /* Linux send()/sendall() use sendto with a NULL destination on connected
     * pairs. Permit that form only; explicit destinations stay forbidden. */
    struct sock_filter send[] = {
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_sendto, 1, 0),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
        REQUIRE_WORD(offsetof(struct seccomp_data, args[4]), 0),
        REQUIRE_WORD(offsetof(struct seccomp_data, args[4]) + 4, 0),
        REQUIRE_WORD(offsetof(struct seccomp_data, args[5]), 0),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
    };
    struct sock_fprog p = {(unsigned short)(sizeof(pair) / sizeof(pair[0])), pair};
    if (prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &p)) die("socketpair filter");
    p.len = (unsigned short)(sizeof(send) / sizeof(send[0])); p.filter = send;
    if (prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &p)) die("local send filter");
}

static void confine(int fd) {
    /* Securebits prevent uid 0 from reacquiring capabilities on exec. */
    if (prctl(PR_SET_SECUREBITS, SECBIT_NOROOT | SECBIT_NOROOT_LOCKED | SECBIT_NO_SETUID_FIXUP | SECBIT_NO_SETUID_FIXUP_LOCKED)) die("securebits");
    struct __user_cap_header_struct h = {_LINUX_CAPABILITY_VERSION_3, 0};
    struct __user_cap_data_struct caps[2] = {{0}, {0}};
    if (syscall(SYS_capset, &h, caps)) die("drop capabilities");
    if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0)) die("no_new_privs");
    if (syscall(SYS_landlock_restrict_self, fd, 0)) die("landlock restrict");
    close(fd);
    struct sock_filter filter[] = {
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, arch)),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, NATIVE_ARCH, 1, 0),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
        BPF_JUMP(BPF_JMP | BPF_JGE | BPF_K, 0x40000000, 0, 1),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
        DENY_NR(SYS_socket), DENY_NR(SYS_connect),
        DENY_NR(SYS_bind), DENY_NR(SYS_listen), DENY_NR(SYS_accept), DENY_NR(SYS_accept4),
        DENY_NR(SYS_sendmsg), DENY_NR(SYS_recvmsg),
        DENY_NR(SYS_ptrace), DENY_NR(SYS_process_vm_readv), DENY_NR(SYS_process_vm_writev),
        DENY_NR(SYS_unshare), DENY_NR(SYS_setns), DENY_NR(SYS_mount), DENY_NR(SYS_umount2),
        DENY_NR(SYS_pivot_root), DENY_NR(SYS_chroot), DENY_NR(SYS_bpf), DENY_NR(SYS_perf_event_open),
        DENY_NR(SYS_open_by_handle_at), DENY_NR(SYS_keyctl), DENY_NR(SYS_add_key), DENY_NR(SYS_request_key),
        DENY_NR(SYS_capset), DENY_NR(SYS_setuid), DENY_NR(SYS_setgid), DENY_NR(SYS_setreuid),
        DENY_NR(SYS_setregid), DENY_NR(SYS_setresuid), DENY_NR(SYS_setresgid), DENY_NR(SYS_setgroups),
        DENY_NR(SYS_setfsuid), DENY_NR(SYS_setfsgid),
        /* Landlock does not mediate metadata-only chmod/chown operations. */
#ifdef SYS_chmod
        DENY_NR(SYS_chmod),
#endif
#ifdef SYS_chown
        DENY_NR(SYS_chown), DENY_NR(SYS_lchown),
#endif
        DENY_NR(SYS_fchmod), DENY_NR(SYS_fchmodat), DENY_NR(452),
        DENY_NR(SYS_fchown), DENY_NR(SYS_fchownat),
        DENY_NR(SYS_setxattr), DENY_NR(SYS_lsetxattr), DENY_NR(SYS_fsetxattr),
        DENY_NR(SYS_removexattr), DENY_NR(SYS_lremovexattr), DENY_NR(SYS_fremovexattr),
        /* io_uring can otherwise perform socket/file operations outside syscall filters. */
        DENY_NR(425), DENY_NR(426), DENY_NR(427), /* io_uring */
        DENY_NR(438), /* pidfd_getfd */
        /* clone3 is opaque to classic BPF. ENOSYS permits libc's safe clone fallback. */
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, 435, 0, 1),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | ENOSYS),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_clone, 0, 3),
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[0])),
        BPF_JUMP(BPF_JMP | BPF_JSET | BPF_K, 0x7e020000, 0, 1), /* CLONE_NEW* */
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
    };
    struct sock_fprog p = {(unsigned short)(sizeof(filter) / sizeof(filter[0])), filter};
    if (prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &p)) die("seccomp");
    local_ipc_filters();
}

static void close_descriptors(int keep) {
    struct rlimit r; if (getrlimit(RLIMIT_NOFILE, &r)) die("getrlimit");
    /* close_range is available on every kernel that supports Landlock ABI 6. */
    if (keep > 3 && syscall(436, 3U, (unsigned int)keep - 1, 0)) die("close_range");
    if (syscall(436, (unsigned int)(keep >= 3 ? keep + 1 : 3), ~0U, 0)) die("close_range");
}

static void kill_children(void) {
    char path[128]; snprintf(path, sizeof(path), "/proc/self/task/%d/children", getpid());
    FILE *f = fopen(path, "r"); if (!f) die("read children");
    int pid; while (fscanf(f, "%d", &pid) == 1) if (pid > 1) kill(pid, SIGKILL);
    fclose(f);
}

static int cleanup(void) {
    double deadline = now() + 8;
    for (;;) {
        kill_children();
        int s; pid_t child;
        while ((child = waitpid(-1, &s, WNOHANG)) > 0) {}
        if (child < 0 && errno == ECHILD) return 1;
        if (now() > deadline) return 0;
        usleep(10000);
    }
}

static int doctor(void) {
    check_kernel();
    pid_t child = fork(); if (child < 0) die("doctor fork");
    if (!child) {
        int fd = ruleset(); /* Only regular shared-memory IPC files, no network. */
        rule(fd, "/dev/shm", SHM_ACCESS);
        confine(fd);
        if (socket(AF_INET, SOCK_STREAM, 0) != -1 || errno != EPERM) _exit(1);
        if (socket(AF_INET6, SOCK_DGRAM, 0) != -1 || errno != EPERM) _exit(2);
        if (socket(AF_UNIX, SOCK_STREAM, 0) != -1 || errno != EPERM) _exit(3);
        if (open("/etc/passwd", O_RDONLY) != -1 || errno != EACCES) _exit(4);
        if (kill(getppid(), 0) != -1 || errno != EPERM) _exit(5);
        int pair[2]; char byte;
        if (socketpair(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC | SOCK_NONBLOCK, 0, pair)) _exit(6);
        if (send(pair[0], "x", 1, 0) != 1 || recv(pair[1], &byte, 1, 0) != 1 || byte != 'x') _exit(7);
        close(pair[0]); close(pair[1]);
        if (socketpair(AF_INET, SOCK_STREAM, 0, pair) != -1 || errno != EPERM) _exit(8);
        if (socketpair(AF_UNIX, SOCK_STREAM, 1, pair) != -1 || errno != EPERM) _exit(9);
        char name[96]; snprintf(name, sizeof(name), "/easy-code-doctor-%d-%ld", getpid(), (long)time(NULL));
        sem_t *sem = sem_open(name, O_CREAT | O_EXCL, 0600, 0);
        if (sem == SEM_FAILED) { perror("Harbor POSIX semaphore probe"); _exit(10); }
        if (sem_unlink(name) || sem_post(sem) || sem_wait(sem) || sem_close(sem)) _exit(11);
        _exit(0);
    }
    int s; if (waitpid(child, &s, 0) != child || !WIFEXITED(s) || WEXITSTATUS(s)) return 78;
    puts("Harbor sandbox ready: Landlock filesystem/signal isolation; local AF_UNIX socketpairs and bounded shared-memory IPC allowed, network sockets denied; no nested namespaces.");
    return 0;
}

static char *fields[MAX_FIELDS]; static int count, cursor;
static char *next(void) { if (cursor >= count) { errno = EINVAL; die("payload fields"); } return fields[cursor++]; }
static int number(void) { char *end, *s = next(); long n = strtol(s, &end, 10); if (*end || n < 0 || n > MAX_FIELDS) die("payload number"); return n; }

int main(int argc, char **argv) {
    if (argc == 2 && !strcmp(argv[1], "--doctor")) return doctor();
    if (argc != 3 || strcmp(argv[1], "--run")) return 78;
    check_kernel();
    int input = open(argv[2], O_RDONLY | O_NOFOLLOW | O_CLOEXEC); if (input < 0) die("payload open");
    struct stat st; if (fstat(input, &st) || !S_ISREG(st.st_mode) || st.st_uid || (st.st_mode & 077) || st.st_size <= 0 || st.st_size > 1048576) die("payload permissions");
    char *bytes = calloc(1, (size_t)st.st_size + 1); if (!bytes) die("payload allocation");
    size_t offset = 0; while (offset < (size_t)st.st_size) { ssize_t n = read(input, bytes + offset, (size_t)st.st_size - offset); if (n <= 0) die("payload read"); offset += n; }
    close(input); if (unlink(argv[2])) die("payload unlink");
    if (bytes[st.st_size - 1]) die("payload delimiter");
    for (char *p = bytes; p < bytes + st.st_size; p += strlen(p) + 1) { if (count >= MAX_FIELDS) die("payload bound"); fields[count++] = p; }
    if (strcmp(next(), "harbor-v1")) die("payload version");
    command_id = next();
    for (const char *p = command_id; *p; p++) if (!( (*p >= 'a' && *p <= 'z') || (*p >= 'A' && *p <= 'Z') || (*p >= '0' && *p <= '9') || *p == '_' || *p == '-')) die("command id");
    char *cwd = next(), *program = next();
    int fd = ruleset(), rules = number();
    for (int i = 0; i < rules; i++) { uint64_t access = (uint64_t)number(); rule(fd, next(), access); }
    int nargs = number(); char **args = calloc((size_t)nargs + 2, sizeof(char *)); if (!args) die("args allocation");
    args[0] = program; for (int i = 0; i < nargs; i++) args[i + 1] = next();
    int nenv = number(); char **env = calloc((size_t)nenv + 1, sizeof(char *)); if (!env) die("env allocation");
    for (int i = 0; i < nenv; i++) env[i] = next();
    if (cursor != count) die("extra payload fields");
    if (prctl(PR_SET_CHILD_SUBREAPER, 1) || prctl(PR_SET_PDEATHSIG, SIGTERM)) die("supervisor");
    if (getppid() == 1) return 78;
    struct sigaction sa = {.sa_handler = stop_handler}; sigemptyset(&sa.sa_mask);
    if (sigaction(SIGTERM, &sa, NULL) || sigaction(SIGINT, &sa, NULL)) die("signals");
    /* A private CLOEXEC pipe proves confinement succeeded before dispatch. */
    int ready[2]; if (pipe2(ready, O_CLOEXEC)) die("ready pipe");
    pid_t target = fork(); if (target < 0) die("fork");
    if (!target) {
        close(ready[0]); signal(SIGTERM, SIG_DFL); signal(SIGINT, SIG_DFL);
        /* No inherited Runtime sockets, control channel or filesystem handles. */
        if (chdir(cwd)) die("target cwd");
        confine(fd); close_descriptors(ready[1]);
        if (write(ready[1], "R", 1) != 1) _exit(78);
        close(ready[1]); execve(program, args, env); perror("target exec"); _exit(127);
    }
    close(fd); close(ready[1]);
    char started; ssize_t n = read(ready[0], &started, 1); close(ready[0]);
    int dispatched = n == 1 && started == 'R';
    if (dispatched) {
        control("{\"type\":\"ready\",\"backend\":\"harbor-landlock\"}");
        control("{\"type\":\"execution_dispatched\"}");
    } else control("{\"type\":\"sandbox_error\",\"message\":\"Harbor target confinement failed before execution\"}");
    int status = 0, exited = 0;
    while (!stopping) {
        pid_t result = waitpid(target, &status, WNOHANG);
        if (result == target) { exited = 1; break; }
        if (result < 0 && errno != EINTR) break;
        usleep(10000);
    }
    int code = exited && WIFEXITED(status) ? WEXITSTATUS(status) : exited && WIFSIGNALED(status) ? 128 + WTERMSIG(status) : 143;
    if (dispatched && exited) { char msg[128]; snprintf(msg, sizeof(msg), "{\"type\":\"execution_exited\",\"exitCode\":%d}", code); control(msg); }
    if (cleanup()) control("{\"type\":\"cleanup_complete\"}");
    else { control("{\"type\":\"cleanup_error\",\"message\":\"Harbor descendants could not be reaped\"}"); return 79; }
    return dispatched ? code : 78;
}
