import { NextResponse, type NextRequest } from "next/server";

const PUBLIC = ["/connexion", "/inscription", "/invitation", "/mot-de-passe-oublie", "/reinitialisation"];

/** Sans cookie de session, toute page de l'application renvoie vers la connexion. */
export function middleware(req: NextRequest) {
  const { pathname, search } = req.nextUrl;
  if (PUBLIC.some((p) => pathname === p || pathname.startsWith(`${p}/`))) return NextResponse.next();
  if (req.cookies.get("am_session")) return NextResponse.next();
  const url = req.nextUrl.clone();
  url.pathname = "/connexion";
  url.search = pathname === "/" ? "" : `?suite=${encodeURIComponent(pathname + search)}`;
  return NextResponse.redirect(url);
}

export const config = {
  // Fichiers publics de l'application installable (manifeste, icônes, service worker) : sans session.
  matcher: ["/((?!_next/|logo\\.jpg|favicon|icons/|manifest\\.webmanifest|sw\\.js|hors-connexion\\.html).*)"],
};
