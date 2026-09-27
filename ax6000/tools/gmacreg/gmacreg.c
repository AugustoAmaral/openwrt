// SPDX-License-Identifier: GPL-2.0-only
/*
 * gmacreg - bench-only peek/poke for the IPQ5018 GMAC register blocks and
 * read-only peek at DRAM (the NSS firmware's descriptor rings). The
 * AX6000 image has no /dev/mem and no devmem applet. Never ship this.
 *
 *   echo '<phys> <words>' > /sys/kernel/debug/gmacreg/peek; cat .../peek
 *   echo '<phys> <value>' > /sys/kernel/debug/gmacreg/poke   (GMAC MMIO only)
 */
#include <linux/module.h>
#include <linux/debugfs.h>
#include <linux/io.h>
#include <linux/seq_file.h>
#include <linux/uaccess.h>

#define GMAC0_BASE	0x39c00000UL
#define GMAC1_BASE	0x39d00000UL
#define GMAC_SIZE	0x10000UL
#define DRAM_START	0x40000000UL
#define DRAM_END	0x60000000UL
#define PEEK_MAX	512

static struct dentry *dir;
static void __iomem *gmac[2];
static phys_addr_t peek_addr;
static unsigned int peek_words;

static void __iomem *gmac_reg(phys_addr_t pa)
{
	if (pa >= GMAC0_BASE && pa < GMAC0_BASE + GMAC_SIZE)
		return gmac[0] + (pa - GMAC0_BASE);
	if (pa >= GMAC1_BASE && pa < GMAC1_BASE + GMAC_SIZE)
		return gmac[1] + (pa - GMAC1_BASE);
	return NULL;
}

static int peek_show(struct seq_file *m, void *v)
{
	unsigned int i;
	void __iomem *reg = gmac_reg(peek_addr);
	u32 *mem = NULL;

	if (!peek_words)
		return 0;
	if (!reg) {
		if (peek_addr < DRAM_START || peek_addr + peek_words * 4 > DRAM_END)
			return -EINVAL;
		mem = memremap(peek_addr, peek_words * 4, MEMREMAP_WB);
		if (!mem)
			return -ENOMEM;
	}
	for (i = 0; i < peek_words; i++) {
		u32 val = reg ? readl(reg + i * 4) : READ_ONCE(mem[i]);

		if (i % 8 == 0)
			seq_printf(m, "%s%08llx:", i ? "\n" : "",
				   (unsigned long long)(peek_addr + i * 4));
		seq_printf(m, " %08x", val);
	}
	seq_putc(m, '\n');
	if (mem)
		memunmap(mem);
	return 0;
}

static int peek_open(struct inode *inode, struct file *file)
{
	return single_open(file, peek_show, NULL);
}

static ssize_t parse2(const char __user *ubuf, size_t count, unsigned long *a,
		      unsigned long *b)
{
	char buf[48];

	if (count >= sizeof(buf))
		return -EINVAL;
	if (copy_from_user(buf, ubuf, count))
		return -EFAULT;
	buf[count] = '\0';
	if (sscanf(buf, "%lx %li", a, b) != 2)
		return -EINVAL;
	return 0;
}

static ssize_t peek_write(struct file *file, const char __user *ubuf,
			  size_t count, loff_t *ppos)
{
	unsigned long a, n;
	ssize_t ret = parse2(ubuf, count, &a, &n);

	if (ret)
		return ret;
	if (!n || n > PEEK_MAX || (a & 3))
		return -EINVAL;
	peek_addr = a;
	peek_words = n;
	return count;
}

static ssize_t poke_write(struct file *file, const char __user *ubuf,
			  size_t count, loff_t *ppos)
{
	unsigned long a, v;
	void __iomem *reg;
	ssize_t ret = parse2(ubuf, count, &a, &v);

	if (ret)
		return ret;
	reg = gmac_reg(a);
	if (!reg || (a & 3))
		return -EINVAL;
	writel((u32)v, reg);
	pr_info("gmacreg: poke %08lx <- %08x (now %08x)\n", a, (u32)v, readl(reg));
	return count;
}

static const struct file_operations peek_fops = {
	.owner = THIS_MODULE, .open = peek_open, .read = seq_read,
	.write = peek_write, .llseek = seq_lseek, .release = single_release,
};

static const struct file_operations poke_fops = {
	.owner = THIS_MODULE, .write = poke_write,
};

static int __init gmacreg_init(void)
{
	gmac[0] = ioremap(GMAC0_BASE, GMAC_SIZE);
	gmac[1] = ioremap(GMAC1_BASE, GMAC_SIZE);
	if (!gmac[0] || !gmac[1]) {
		if (gmac[0])
			iounmap(gmac[0]);
		if (gmac[1])
			iounmap(gmac[1]);
		return -ENOMEM;
	}
	dir = debugfs_create_dir("gmacreg", NULL);
	debugfs_create_file("peek", 0600, dir, NULL, &peek_fops);
	debugfs_create_file("poke", 0200, dir, NULL, &poke_fops);
	return 0;
}

static void __exit gmacreg_exit(void)
{
	debugfs_remove_recursive(dir);
	iounmap(gmac[0]);
	iounmap(gmac[1]);
}

module_init(gmacreg_init);
module_exit(gmacreg_exit);
MODULE_LICENSE("GPL");
MODULE_DESCRIPTION("bench-only GMAC register peek/poke");
