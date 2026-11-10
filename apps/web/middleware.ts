import { NextResponse, type NextRequest } from "next/server";

const PUBLIC = ["/connexion", "/inscription", "/invitation"];

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
  matcher: ["/((?!_next/|logo\\.jpg|favicon).*)"],
};
