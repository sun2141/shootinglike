"""config-driven camera calibration: goal corners + penalty line + D arc (+ optional heights)"""
import numpy as np, cv2, json, pickle, sys
from scipy.optimize import least_squares
def run(cfg, use_h=True, verbose=True):
    W,H=cfg['size']; cx,cy=W/2,H/2
    goal_img=np.array(cfg['goal'],float)   # BL BR TR TL
    obj=np.array([[-3.72,0,0],[3.72,0,0],[3.72,0,2.50],[-3.72,0,2.50]])
    pts=np.array(json.load(open(cfg['lines'])))
    # ransac straight line for penalty line
    best=None; rng=np.random.default_rng(0)
    cand=pts[(pts[:,0]>=cfg['xrange'][0])&(pts[:,0]<=cfg['xrange'][1])]
    for _ in range(3000):
        a,b=cand[rng.choice(len(cand),2,replace=False)]
        if abs(a[0]-b[0])<200: continue
        k=(b[1]-a[1])/(b[0]-a[0]); d=np.abs(cand[:,1]-(a[1]+k*(cand[:,0]-a[0])))
        n=(d<3).sum()
        if best is None or n>best[0]: best=(n,a,k)
    _,a,k=best; yl=lambda x: a[1]+k*(x-a[0])
    pen=cand[np.abs(cand[:,1]-yl(cand[:,0]))<3.5]
    arc=cand[(cand[:,1]-yl(cand[:,0])>5)&(cand[:,0]>cfg['arcx'][0])&(cand[:,0]<cfg['arcx'][1])]
    heights=cfg.get('heights',[])
    def proj(f,R,t,P): Pc=(R@np.atleast_2d(P).T).T+t; return np.c_[f*Pc[:,0]/Pc[:,2]+cx,f*Pc[:,1]/Pc[:,2]+cy]
    def ground(f,R,t,P,z=0.0):
        C=-R.T@t; d=(R.T@np.c_[(P[:,0]-cx)/f,(P[:,1]-cy)/f,np.ones(len(P))].T).T; s=(z-C[2])/d[:,2]; return C+s[:,None]*d
    def res(p,uh):
        f=p[0]; R,_=cv2.Rodrigues(p[1:4]); t=p[4:7]
        r=list((proj(f,R,t,obj)-goal_img).ravel())
        Pp=ground(f,R,t,pen); Pa=ground(f,R,t,arc); sc=4/np.sqrt(len(pen)+len(arc))
        r+=list((Pp[:,1]+16.5)/0.15*sc)+list((np.hypot(Pa[:,0],Pa[:,1]+11)-9.15)/0.15*sc)
        if uh:
            for b,tp,Hm,_ in heights:
                P=ground(f,R,t,np.array([b]))[0]; r.append((proj(f,R,t,P+[0,0,Hm])[0][1]-tp[1])/2.0)
        return np.array(r)
    def init(f):
        C=np.array(cfg['cam_guess'],float); tgt=np.array([0,0,1.0])
        zc=tgt-C; zc/=np.linalg.norm(zc); xc=np.cross(zc,[0,0,1]); xc/=np.linalg.norm(xc); yc=np.cross(zc,xc)
        R=np.vstack([xc,yc,zc]); rv,_=cv2.Rodrigues(R); return np.r_[f,rv.ravel(),-R@C]
    bestr=None
    for f0 in (1200,1500,1900):
        r=least_squares(lambda p: res(p,use_h),init(f0))
        if bestr is None or r.cost<bestr.cost: bestr=r
    p=bestr.x; f=p[0]; R,_=cv2.Rodrigues(p[1:4]); t=p[4:7]; C=-R.T@t
    out=dict(f=f,R=R,t=t,C=C,size=cfg['size'])
    if verbose:
        rr=res(p,False)
        print(f"f={f:.1f} camC={C.round(2)} goal rms={np.sqrt((rr[:8]**2).mean()):.2f}px  pen n={len(pen)} arc n={len(arc)}")
        G=ground(f,R,t,pen); A=ground(f,R,t,arc); print(f"  pen dist mean {-G[:,1].mean():.2f} sd {G[:,1].std():.2f} | arc r {np.hypot(A[:,0],A[:,1]+11).mean():.2f} sd {np.hypot(A[:,0],A[:,1]+11).std():.2f}")
        for b,tp,Hm,nm in heights:
            P=ground(f,R,t,np.array([b]))[0]; pr=proj(f,R,t,P+[0,0,Hm])[0][1]
            print(f"  {nm}: meas {b[1]-tp[1]:.1f}px pred {b[1]-pr:.1f}px ratio {(b[1]-tp[1])/(b[1]-pr):.3f} dist {np.linalg.norm(P-C):.1f}m")
        for nm,bc in cfg.get('balls',{}).items():
            P0=ground(f,R,t,np.array([bc[:2]]),0.11)[0]
            u=np.random.default_rng(0).normal(size=(3000,3)); u/=np.linalg.norm(u,axis=1)[:,None]; pb=proj(f,R,t,P0+0.11*u)
            print(f"  ball {nm}: to goal line {-P0[1]:.2f}m  x {P0[0]:.2f}  pred w {np.ptp(pb[:,0]):.1f}px" + (f" meas {bc[2]}" if len(bc)>2 else ''))
    return out
if __name__=='__main__':
    cfg=json.load(open(sys.argv[1])); tag=sys.argv[2]
    for uh,suf in ((True,''),(False,'_noh')):
        print('== heights' if uh else '== no heights'); o=run(cfg,uh); pickle.dump(o,open(f'cal_{tag}{suf}.pkl','wb'))
