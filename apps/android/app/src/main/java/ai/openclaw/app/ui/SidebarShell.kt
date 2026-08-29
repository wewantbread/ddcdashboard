package ai.openclaw.app.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.widthIn
import androidx.compose.material3.DrawerState
import androidx.compose.material3.ModalDrawerSheet
import androidx.compose.material3.ModalNavigationDrawer
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp

/**
 * Sidebar-owned top-level navigation.
 *
 * Pages are opened from the sidebar Pages menu on every window size. The old
 * adaptive bar/rail/drawer suite is intentionally absent so there is a single
 * navigation owner and no compact bottom menu can reappear.
 */
@Composable
internal fun SidebarNavigationShell(
  drawerState: DrawerState,
  gesturesEnabled: Boolean = true,
  drawerContent: @Composable () -> Unit,
  content: @Composable () -> Unit,
) {
  ModalNavigationDrawer(
    drawerState = drawerState,
    gesturesEnabled = gesturesEnabled,
    drawerContent = {
      ModalDrawerSheet(
        drawerState = drawerState,
        modifier = Modifier.widthIn(max = 360.dp).testTag("sidebar-drawer"),
      ) {
        drawerContent()
      }
    },
  ) {
    Box(modifier = Modifier.fillMaxSize()) {
      content()
    }
  }
}
