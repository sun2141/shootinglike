from field import *
from scipy.optimize import least_squares
obj=np.array([[-3.72,0,0],[3.72,0,0],[3.72,0,2.50],[-3.72,0,2.50]])
def undist(uv,f,k1):
    # simple radial model on normalized coords (approx inverse)
    xn=(uv[:,0]-cx)/f; yn=(uv[:,1]-cy)/f; r2=xn**2+yn**2; s=1/(1+k1*r2)
    return np.c_[xn*s,yn*s]
def res(p,use_k):
    f=p[0]; rv=p[1:4]; tv=p[4:7]; k1=p[7] if use_k else 0.0
    R,_=cv2.Rodrigues(rv); C=-R.T@tv
    # goal corners: project with distortion
    Pc=(R@obj.T).T+tv; xn=Pc[:,0]/Pc[:,2]; yn=Pc[:,1]/Pc[:,2]; r2=xn**2+yn**2; d=1+k1*r2
    uv=np.c_[f*xn*d+cx,f*yn*d+cy]; rg=(uv-goal_img).ravel()
    def ground(P):
        n=undist(P,f,k1); dirs=(R.T@np.c_[n,np.ones(len(n))].T).T; s=-C[2]/dirs[:,2]; return C+s[:,None]*dirs
    Pp=ground(pen); Pa=ground(arc)
    return np.r_[rg, (Pp[:,1]+16.5)/0.15, (np.hypot(Pa[:,0],Pa[:,1]+11)-9.15)/0.15]
R0,t0,C0,e0=pose(1600,7.44,2.50); rv0,_=cv2.Rodrigues(R0)
for use_k in (False,True):
    p0=np.r_[1600,rv0.ravel(),t0]
    if use_k: p0=np.r_[p0,0.0]
    r=least_squares(res,p0,args=(use_k,))
    rr=r.fun; ng=8; npn=len(pen)
    print('k1' if use_k else 'no-k', 'f=',round(r.x[0],1),'k1=',round(r.x[7],3) if use_k else '-', 'goal px rms',round(np.sqrt((rr[:ng]**2).mean()),2),
          'pen m rms',round(np.sqrt((rr[ng:ng+npn]**2).mean())*0.15,3),'arc m rms',round(np.sqrt((rr[ng+npn:]**2).mean())*0.15,3))
    R,_=cv2.Rodrigues(r.x[1:4]); print('   camH',round((-R.T@r.x[4:7])[2],2))
