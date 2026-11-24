const nextConfig={
  async headers(){
    return [{source:'/:path*',headers:[
      {key:'Referrer-Policy',value:'no-referrer'},
      {key:'X-Robots-Tag',value:'noindex, nofollow'},
      {key:'X-Content-Type-Options',value:'nosniff'},
      {key:'X-Frame-Options',value:'DENY'},
      {key:'Permissions-Policy',value:'camera=(self), microphone=(self)'},
      {key:'Content-Security-Policy',value:"frame-ancestors 'none'; base-uri 'self'; object-src 'none'"}
    ]}];
  }
};
export default nextConfig;
