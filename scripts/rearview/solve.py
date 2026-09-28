import numpy as np, cv2, json, sys
from scipy.optimize import least_squares, brentq
W_IMG,H_IMG=1920,1080; cx,cy=W_IMG/2,H_IMG/2
goal_img=np.array([[1124,591],[1485,601],[1485,461],[1124.5,469.5]],float)  # BL BR TR TL
ball_c=np.array([469.5,779.0]); ball_w=53.8; ball_h=48.6
R_B=0.11; G=9.81
trk=[r for r in json.load(open('/mnt/user-data/uploads/shooting-like/ref-rear/_work/t04b.json')) if r[2] is not None]
def K(f): return np.array([[f,0,cx],[0,f,cy],[0,0,1.]])
def pose(f,W,H):
    obj=np.array([[-W/2,0,0],[W/2,0,0],[W/2,0,H],[-W/2,0,H]],float)
    n,rs,ts,errs=cv2.solvePnPGeneric(obj,goal_img,K(f),None,flags=cv2.SOLVEPNP_IPPE)
    best=None
    for rv,tv in zip(rs,ts):
        R,_=cv2.Rodrigues(rv); C=(-R.T@tv).ravel()
        if C[2]<=0: continue
        pr,_=cv2.projectPoints(obj,rv,tv,K(f),None); e=np.sqrt(((pr.reshape(-1,2)-goal_img)**2).sum(1).mean())
        if best is None or e<best[3]: best=(R,tv.ravel(),C,e)
    return best
def ray_plane(f,R,t,uv,z):
    d_cam=np.array([(uv[0]-cx)/f,(uv[1]-cy)/f,1.0]); d=R.T@d_cam; C=-R.T@t
    s=(z-C[2])/d[2]; return C+s*d
def proj(f,R,t,P):
    Pc=(R@P.T).T+t; return np.c_[f*Pc[:,0]/Pc[:,2]+cx, f*Pc[:,1]/Pc[:,2]+cy]
_u=np.random.default_rng(0).normal(size=(4000,3)); _u/=np.linalg.norm(_u,axis=1)[:,None]
def ball_bbox(f,R,t,Pc):
    p=proj(f,R,t,Pc+R_B*_u); return np.ptp(p[:,0]), np.ptp(p[:,1])
def fit_f(W,H,bw=ball_w):
    def g(f):
        R,t,C,e=pose(f,W,H); P0=ray_plane(f,R,t,ball_c,R_B); return ball_bbox(f,R,t,P0)[0]-bw
    fs=np.linspace(700,4000,67); vals=[g(f) for f in fs]
    for a,b,va,vb in zip(fs[:-1],fs[1:],vals[:-1],vals[1:]):
        if va*vb<0: return brentq(g,a,b)
    return None
def simulate(P0,v0,ts,k):
    out=[];P=P0.copy();v=v0.copy();t=0.0;dt=0.002;j=0
    for T in ts:
        while t<T-1e-9:
            h=min(dt,T-t)
            def acc(v): return np.array([0,0,-G])-k*np.linalg.norm(v)*v
            k1v=acc(v);k1p=v
            k2v=acc(v+h/2*k1v);k2p=v+h/2*k1v
            k3v=acc(v+h/2*k2v);k3p=v+h/2*k2v
            k4v=acc(v+h*k3v);k4p=v+h*k3v
            P=P+h/6*(k1p+2*k2p+2*k3p+k4p); v=v+h/6*(k1v+2*k2v+2*k3v+k4v); t+=h
        out.append(P.copy())
    return np.array(out)
def fit_traj(f,W,H,k,frames=(42,118),t0_fix=None):
    R,t,C,e=pose(f,W,H); P0=ray_plane(f,R,t,ball_c,R_B)
    obs=np.array([[r[1],r[2],r[3]] for r in trk if frames[0]<=r[0]<=frames[1]])
    def res(p):
        v0=p[:3]; t0=p[3] if t0_fix is None else t0_fix
        tt=obs[:,0]-t0
        if (tt<=0).any(): return np.full(2*len(obs),1e3)
        P=simulate(P0,v0,tt,k); uv=proj(f,R,t,P); return (uv-obs[:,1:]).ravel()
    # init: direction toward goal center
    dirn=np.array([0,0,1.2])-P0; dirn[2]=0; dirn/=np.linalg.norm(dirn)
    best=None
    for sp in (15,25,35):
      for el in (10,20,30):
        v=sp*np.r_[dirn[:2]*np.cos(np.radians(el)),np.sin(np.radians(el))]
        p0=np.r_[v,0.64] if t0_fix is None else v
        r=least_squares(res,p0,x_scale='jac')
        if best is None or r.cost<best.cost: best=r
    v0=best.x[:3]; t0=best.x[3] if t0_fix is None else t0_fix
    rms=np.sqrt((best.fun**2).mean()*2)
    return dict(P0=P0,v0=v0,t0=t0,rms=rms,R=R,t=t,C=C,pnp=e,speed=np.linalg.norm(v0)*3.6,
                elev=np.degrees(np.arcsin(v0[2]/np.linalg.norm(v0))))
if __name__=='__main__':
    for (W,H,name) in [(7.32,2.44,'adult'),(6.0,2.0,'6x2'),(5.0,2.0,'5x2')]:
        f=fit_f(W,H)
        if f is None: print(name,'no f'); continue
        for k in (0.0,0.012):
            r=fit_traj(f,W,H,k)
            dist=np.linalg.norm(r['P0'][:2]-0)  # ball to goal-center ground
            print(f"{name:6s} f={f:7.1f} pnpErr={r['pnp']:.2f}px camH={r['C'][2]:.2f}m camDist={np.linalg.norm(r['C']):.1f} ballToGoal={dist:5.1f}m k={k} "
                  f"v0={r['speed']:6.1f}km/h elev={r['elev']:5.1f} t0={r['t0']:.3f} rms={r['rms']:.2f}px")
