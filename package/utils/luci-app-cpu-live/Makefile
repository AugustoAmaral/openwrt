# SPDX-License-Identifier: GPL-2.0-only
#
# Live CPU and NSS core load graph for LuCI, sampled in the browser only while
# the page is open.

include $(TOPDIR)/rules.mk

PKG_NAME:=luci-app-cpu-live
PKG_RELEASE:=1

include $(INCLUDE_DIR)/package.mk

define Package/luci-app-cpu-live
  SECTION:=luci
  CATEGORY:=LuCI
  SUBMENU:=3. Applications
  TITLE:=LuCI live CPU and NSS core load graph
  DEPENDS:=+luci-base
  PKGARCH:=all
endef

define Package/luci-app-cpu-live/description
 Status -> CPU Load: per-core CPU usage from /proc/stat and, when the NSS
 driver is loaded, the NSS core load, drawn in the browser every two seconds
 while the page is open. Nothing runs or is stored on the router between
 visits.
endef

define Build/Compile
endef

define Package/luci-app-cpu-live/install
	$(INSTALL_DIR) $(1)/www/luci-static/resources/view/cpu-live
	$(INSTALL_DATA) ./files/index.js $(1)/www/luci-static/resources/view/cpu-live/index.js
	$(INSTALL_DIR) $(1)/usr/share/luci/menu.d
	$(INSTALL_DATA) ./files/menu.json $(1)/usr/share/luci/menu.d/luci-app-cpu-live.json
	$(INSTALL_DIR) $(1)/usr/share/rpcd/acl.d
	$(INSTALL_DATA) ./files/acl.json $(1)/usr/share/rpcd/acl.d/luci-app-cpu-live.json
endef

define Package/luci-app-cpu-live/postinst
#!/bin/sh
[ -n "$${IPKG_INSTROOT}" ] || {
	rm -f /tmp/luci-indexcache.*
	rm -rf /tmp/luci-modulecache/
	killall -HUP rpcd 2>/dev/null
	exit 0
}
endef

$(eval $(call BuildPackage,luci-app-cpu-live))
