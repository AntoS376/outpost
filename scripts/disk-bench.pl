# Disk speed for Outpost's benchmark: writes then reads <megabytes> in <file> with macOS's F_NOCACHE, so the
# read comes from the disk rather than from memory (a cached read on an M3 Pro showed 16 GB/s; uncached, 3 GB/s).
#   perl disk-bench.pl <file> <megabytes>    prints: {"write":MBps,"read":MBps}
use strict; use warnings; use Fcntl; use Time::HiRes qw(time);
my ($file, $mb) = @ARGV;
die "usage: disk-bench.pl <file> <megabytes>\n" unless $file && $mb;
my $F_NOCACHE = 48; # <sys/fcntl.h>
srand(42);
my $chunk = join('', map { chr(int(rand(256))) } 1 .. (1 << 20)); # 1 MB that won't compress
sysopen(my $w, $file, O_WRONLY | O_CREAT | O_TRUNC) or die "Can't create $file: $!\n";
fcntl($w, $F_NOCACHE, 1);
my $t = time;
for (1 .. $mb) { defined(syswrite($w, $chunk)) or die "Write failed: $!\n"; }
system('/bin/sync') == 0 or die "sync failed\n";
close $w;
my $write = $mb / (time - $t);
sysopen(my $r, $file, O_RDONLY) or die "Can't read $file: $!\n";
fcntl($r, $F_NOCACHE, 1);
my $buf;
$t = time;
while (sysread($r, $buf, 1 << 20)) { }
my $read = $mb / (time - $t);
close $r;
unlink $file;
printf "{\"write\":%.1f,\"read\":%.1f}\n", $write, $read;
