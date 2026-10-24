import { UserButton, useAuth } from "@clerk/react";
import { LogInIcon } from "lucide-react";

import { hasCloudPublicConfig } from "../../cloud/publicConfig";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "../ui/sidebar";
import { PAPERPLANE_CONNECT_ACCOUNT_PAGES } from "./PaperplaneConnectAccountPages";
import { usePaperplaneConnectAuthPrompt } from "./usePaperplaneConnectAuthPrompt";

export function PaperplaneConnectSidebarSignIn() {
  if (!hasCloudPublicConfig()) return null;

  return <ConfiguredPaperplaneConnectSidebarSignIn />;
}

export function PaperplaneConnectSidebarAvatar() {
  if (!hasCloudPublicConfig()) return null;

  return <ConfiguredPaperplaneConnectSidebarAvatar />;
}

function ConfiguredPaperplaneConnectSidebarAvatar() {
  const { isLoaded, isSignedIn } = useAuth();

  if (!isLoaded || !isSignedIn) return null;

  return (
    <UserButton
      appearance={{
        elements: {
          avatarBox: "size-7",
          userButtonTrigger: "rounded-lg p-1 hover:bg-sidebar-row-hover",
        },
      }}
    >
      {PAPERPLANE_CONNECT_ACCOUNT_PAGES.map((page) => (
        <UserButton.UserProfilePage
          key={page.url}
          label={page.label}
          labelIcon={page.icon}
          url={page.url}
        >
          {page.content}
        </UserButton.UserProfilePage>
      ))}
    </UserButton>
  );
}

function ConfiguredPaperplaneConnectSidebarSignIn() {
  const { isLoaded, isSignedIn } = useAuth();
  const { authPrompt, openAuthPrompt } = usePaperplaneConnectAuthPrompt();

  if (!isLoaded || isSignedIn) return null;

  return (
    <>
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton onClick={openAuthPrompt}>
            <LogInIcon />
            <span>Sign in to Paperplane Connect</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
      {authPrompt}
    </>
  );
}
