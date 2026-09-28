import json, numpy as np
from solve import pose, ray_plane, proj, G
from scipy.optimize import least_squares
def sim(P0,v0,k,s,T,dt=0.002):
    n=int(T/dt)+2; P=np.zeros((n,3)); p=P0.astype(float).copy(); v=v0.astype(float).copy(); P[0]=p
    g=np.array([0,0,-G])
    for i in range(1,n):
        a1=g-k*np.linalg.norm(v)*v+np.cross(s,v); vm=v+0.5*dt*a1
        a2=g-k*np.linalg.norm(vm)*vm+np.cross(s,vm); p=p+dt*vm; v=v+dt*a2; P[i]=p
    return np.arange(n)*dt,P
def run(trk,ball_c,f,W,H,frames,arrival=None,kfix=None):
    R,t,C,e=pose(f,W,H); P0=ray_plane(f,R,t,ball_c,0.11)
    obs=np.array([[r[1],r[2],r[3]] for r in trk if r[2] is not None and frames[0]<=r[0]<=frames[1]])
    def unpack(p):
        return p[:3],p[3],(kfix if kfix is not None else p[4]),p[5:8]
    def res(p):
        v,t0,k,s=unpack(p); tt=obs[:,0]-t0
        if (tt<0).any(): return np.full(2*len(obs)+(3 if arrival else 0)+1,1e3)
        ts,P=sim(P0,v,k,s,tt.max()+0.05)
        Pi=np.c_[[np.interp(tt,ts,P[:,j]) for j in range(3)]].T
        r=list((proj(f,R,t,Pi)-obs[:,1:]).ravel())
        r.append(0.0)
        if arrival is not None:
            ta,Pa,sig=arrival; tt2=ta-t0; ts2,P2=sim(P0,v,k,s,tt2+0.01); pa=np.array([np.interp(tt2,ts2,P2[:,j]) for j in range(3)])
            r+=list(((pa-Pa)/sig)*1.0)
        return np.array(r)
    d=-P0[:2]/np.linalg.norm(P0[:2]); best=None
    for sp in (25,):
      for el in (15,30):
        for az in (0,):
          a=np.radians(az); dx=np.array([d[0]*np.cos(a)-d[1]*np.sin(a), d[0]*np.sin(a)+d[1]*np.cos(a)])
          v=sp*np.r_[dx*np.cos(np.radians(el)),np.sin(np.radians(el))]
          r=least_squares(res,np.r_[v,obs[0,0]-0.05,0.012,0,0,0],bounds=([-60,-60,-60,obs[0,0]-0.2,0.006,-1,-1,-1],[60,60,60,obs[0,0]-0.005,0.018,1,1,1]))
          if best is None or r.cost<best.cost: best=r
    v,t0,k,s=unpack(best.x); nimg=2*len(obs); rms=np.sqrt((best.fun[:nimg]**2).mean())*np.sqrt(2); arr=best.fun[nimg+1:]
    ts,P=sim(P0,v,k,s,2.5)
    iy=np.argmax(P[:,1]>=0) if (P[:,1]>=0).any() else None
    return dict(speed=np.linalg.norm(v)*3.6,elev=np.degrees(np.arcsin(v[2]/np.linalg.norm(v))),t0=t0,k=k,spin=s,rms=rms,P0=P0,
                cross=(t0+ts[iy],P[iy]) if iy else None,C=C,v=v,arr=arr)
if __name__=='__main__':
    import sys
    clips={'04':('/mnt/user-data/uploads/shooting-like/ref-rear/_work/t04b.json',[469.5,779.0],(42,118)),
           '05':('/mnt/user-data/uploads/shooting-like/ref-rear/_work/t05b.json',[458.3,766.6],(114,197))}
    which=sys.argv[1]; fs=[int(x) for x in sys.argv[2].split(',')]
    trk=json.load(open(clips[which][0]))
    for f in fs:
        arrival=None
        if which=='05' and len(sys.argv)>3:
            R_,t_,C_,e_=pose(f,7.44,2.50); import numpy as _n
            # ray of pixel at frame 199.5 intersect goal plane y=0
            uv=_n.array([1407.2,457.0]); dc=_n.array([(uv[0]-960)/f,(uv[1]-540)/f,1.0]); d=R_.T@dc; Cc=-R_.T@t_; sgo=-Cc[1]/d[1]; Pa=Cc+sgo*d
            arrival=(3.328,Pa,_n.array([0.15,0.3,0.15])); print('arrival point',Pa.round(2))
        r=run(trk,np.array(clips[which][1]),f,7.44,2.50,clips[which][2],arrival=arrival)
        c=r['cross']
        R_,t_,C_,e_=pose(f,7.44,2.50); ts,P=sim(r['P0'],r['v'],r['k'],r['spin'],2.2)
        uv=proj(f,R_,t_,P); json.dump(dict(t0=r['t0'],uv=uv[::5].tolist(),tt=(ts[::5]+r['t0']).tolist(),speed=r['speed'],elev=r['elev'],f=f,dist=float(np.linalg.norm(r['P0'][:2]))),open(f'traj_{which}_{f}.json','w'))
        print(which,f,f"v0={r['speed']:.1f}km/h elev={r['elev']:.1f} rms={r['rms']:.2f}px k={r['k']:.4f} spin={r['spin'].round(2)} |aM|~{np.linalg.norm(np.cross(r['spin'],r['v'])):.1f}m/s2 t0={r['t0']:.3f} dist={np.linalg.norm(r['P0'][:2]):.1f}m",
              f" arrRes={r['arr'].round(2)}",(f"goal-line at video t={c[0]:.3f} x={c[1][0]:.2f} z={c[1][2]:.2f}" if c else 'no crossing'),flush=True)
